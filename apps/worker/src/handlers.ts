import { GitHubEventSchema } from '@humanize/domain';
import type { GitHubEvent,JobPayload,ReviewSnapshot } from '@humanize/domain';
import type { Database,RunStore } from '@humanize/db';
import { CONFIG_PATH,OrganizationPolicySchema,loadRepositoryConfig,resolveConfiguration } from '@humanize/config';
import type { OrganizationPolicy } from '@humanize/config';
import type { AdministrationStore } from '@humanize/db';
import { fingerprint } from '@humanize/shared';

/** Reads a file from the trusted base commit. Never the head: a pull request must not
 *  weaken the review that judges it (ADR-027). */
export interface TrustedFileSource {
  read(args:{installationId:number;githubRepositoryId:number;owner:string;name:string;ref:string;path:string}):Promise<{content:string;sha:string}|null>;
}
export interface ReviewScheduler { enqueue(payload:JobPayload):Promise<void>; }
export interface EventContext {
  db:Database;
  runs?:RunStore;
  config?:TrustedFileSource;
  /** Reads the administrator policy that governs a review; defaults apply when unset. */
  policy?:(organizationId:string)=>Promise<OrganizationPolicy>;
  administration?:AdministrationStore;
  scheduler?:ReviewScheduler;
}
export type EventOutcome=
  |{action:'ignored';reason:string}
  |{action:'installation_recorded';repositories:number}
  |{action:'repository_recorded'}
  |{action:'pull_request_recorded';generation:number}
  |{action:'review_scheduled';pullNumber:number;headSha:string;generation:number;runId?:string;configHash?:string};

const REVIEWABLE=new Set(['opened','synchronize','reopened','ready_for_review']);

/**
 * Turns a recorded webhook delivery into durable state, and schedules a review when a pull
 * request changes in a way that warrants one. Every path is idempotent: the queue redelivers,
 * and a developer pushing three commits in a minute must not produce three published reviews.
 */
export async function handleGitHubEvent(raw:GitHubEvent,context:EventContext):Promise<EventOutcome> {
  const event=GitHubEventSchema.parse(raw);
  const { db }=context;

  if(event.event==='installation'){
    // A suspended or deleted installation must stop work rather than merely stop arriving.
    const suspended=event.action==='suspend';
    const deleted=event.action==='deleted';
    await db.pool.query(
      `INSERT INTO github_installations(id,organization_id,suspended,deleted)
       SELECT $1,id,$3,$4 FROM organizations WHERE github_account_id=$2
       ON CONFLICT(id) DO UPDATE SET
         -- Removal is terminal. A redelivered older event must never restore access that
         -- was taken away, so deleted only ever moves from false to true.
         deleted=github_installations.deleted OR EXCLUDED.deleted,
         suspended=CASE WHEN github_installations.deleted OR EXCLUDED.deleted THEN github_installations.suspended ELSE EXCLUDED.suspended END`,
      [event.installationId,event.accountId,suspended,deleted]);
    return {action:'installation_recorded',repositories:event.addedRepositoryIds.length};
  }

  if(event.repository===null)return {action:'ignored',reason:'no_repository'};

  const repository=await db.pool.query<{id:string;enabled:boolean;organization_id:string}>(
    `INSERT INTO repositories(organization_id,installation_id,github_repository_id,owner,name,default_branch)
     SELECT o.id,$1,$2,$3,$4,$5 FROM organizations o WHERE o.github_account_id=$6
     ON CONFLICT(github_repository_id) DO UPDATE SET owner=EXCLUDED.owner,name=EXCLUDED.name,default_branch=EXCLUDED.default_branch
     RETURNING id,enabled,organization_id`,
    [event.installationId,event.repository.githubId,event.repository.owner,event.repository.name,event.repository.defaultBranch,event.accountId]);
  const record=repository.rows[0];
  if(!record)return {action:'ignored',reason:'unknown_organization'};
  if(event.event!=='pull_request'||event.pull===null)return {action:'repository_recorded'};
  // A repository nobody enabled is recorded but never reviewed.
  if(!record.enabled)return {action:'ignored',reason:'repository_disabled'};
  if(!REVIEWABLE.has(event.action))return {action:'ignored',reason:`action_${event.action}`};
  if(event.pull.draft&&event.action!=='ready_for_review')return {action:'ignored',reason:'draft'};

  // The generation advances whenever the head moves, so an earlier run for a superseded head
  // can be recognised as stale rather than racing the newer one.
  const pull=await db.pool.query<{generation:number;head_sha:string}>(
    `INSERT INTO pull_requests(organization_id,repository_id,number,head_sha,base_sha,state,draft,generation,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)
     ON CONFLICT(organization_id,repository_id,number) DO UPDATE SET
       head_sha=EXCLUDED.head_sha,base_sha=EXCLUDED.base_sha,state=EXCLUDED.state,draft=EXCLUDED.draft,
       generation=pull_requests.generation+(CASE WHEN pull_requests.head_sha<>EXCLUDED.head_sha THEN 1 ELSE 0 END),
       -- Stamped with when GitHub says the change happened, so ordering survives redelivery.
       updated_at=EXCLUDED.updated_at
     WHERE pull_requests.updated_at <= EXCLUDED.updated_at
     RETURNING generation,head_sha`,
    [record.organization_id,record.id,event.pull.number,event.pull.headSha,event.pull.baseSha,event.pull.state,event.pull.draft,event.occurredAt]);

  // No row means a newer event already described this pull request, so this one is obsolete.
  const updated=pull.rows[0];
  if(!updated)return {action:'ignored',reason:'superseded_by_newer_event'};

  const scheduled={action:'review_scheduled' as const,pullNumber:event.pull.number,headSha:updated.head_sha,generation:updated.generation};
  if(!context.runs||!context.config||!context.scheduler||!(context.policy||context.administration))return scheduled;

  // Configuration is read from the base commit, so the pull request cannot change the rules
  // it will be judged by (ADR-027). A missing file is normal and means administrator defaults.
  const file=await context.config.read({installationId:event.installationId,githubRepositoryId:event.repository.githubId,owner:event.repository.owner,name:event.repository.name,ref:event.pull.baseRef,path:CONFIG_PATH});
  const loaded=file?loadRepositoryConfig(file.content):{config:null,violations:[]};
  const policy=await resolvePolicy(record.organization_id,context);
  if(!policy)return {action:'ignored',reason:'no_organization_policy'};
  const effective=resolveConfiguration({policy,repository:loaded.config});

  const snapshot:ReviewSnapshot={
    version:1,organizationId:record.organization_id,repositoryId:record.id,installationId:event.installationId,
    owner:event.repository.owner,repository:event.repository.name,pullNumber:event.pull.number,
    baseSha:event.pull.baseSha,headSha:updated.head_sha,
    configSha:file?.sha??'0'.repeat(40),configHash:effective.digest,
    executionMode:effective.executionMode,retentionMode:effective.retentionMode,
    reviewer:{...effective.reviewer,credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},
    verifier:{...effective.verifier,credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},
    language:'en',allowUnevaluatedLanguage:false,
  };
  // Run creation is keyed by head and configuration, so a redelivery reuses the same run.
  const runId=await context.runs.create(snapshot,updated.generation);
  await context.scheduler.enqueue({
    version:1,organizationId:record.organization_id,repositoryId:record.id,runId,headSha:updated.head_sha,
    traceId:runId,idempotencyKey:fingerprint(['review',runId,updated.generation]),
  });
  return {...scheduled,runId,configHash:effective.digest};
}

/**
 * Administrator policy, from the stored record when one exists. A review must not run on
 * guessed settings, so an organization with no policy is skipped rather than defaulted into
 * a provider, retention mode or execution mode nobody chose.
 */
async function resolvePolicy(organizationId:string,context:EventContext):Promise<OrganizationPolicy|null> {
  if(context.policy)return context.policy(organizationId);
  const stored=await context.administration?.policy(organizationId);
  if(stored===null||stored===undefined)return null;
  const parsed=OrganizationPolicySchema.safeParse(stored);
  // A policy that no longer satisfies its schema is treated as absent rather than patched.
  return parsed.success?parsed.data:null;
}
