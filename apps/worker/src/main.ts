import { AdministrationStore,Database,EncryptedSecretStore,PublicationStore,RunStore,RunnerStore,migrate } from '@humanize/db';
import { JobQueue } from '@humanize/queue';
import { GitHubEventSchema } from '@humanize/domain';
import { LIMITS } from '@humanize/domain';
import type { ReviewSnapshot } from '@humanize/domain';
import { GitHubFileSource,GitHubTokenBroker,ReviewPublisher,StaleHeadError,buildCheck,buildReview,fetchDiffMap,githubClient } from '@humanize/github';
import { createProvider } from '@humanize/providers';
import { cipherFromEnvironment } from '@humanize/security';
import { executeReview } from '@humanize/execution';
import { executeCloudReview } from './cloud-worker.js';
import { attachSuggestions,findingsFromResult,planPublication } from '@humanize/review';
import { handleGitHubEvent } from './handlers.js';
import { publishReview } from './publish-worker.js';
import { dispatchReview } from './review-worker.js';

const url=process.env.DATABASE_URL;
if(!url)throw Error('DATABASE_URL is required');

const db=new Database(url);
await migrate(db);
const queue=new JobQueue(url);
await queue.start();
const publications=new PublicationStore(db);
const runs=new RunStore(db);
const administration=new AdministrationStore(db);
const runners=new RunnerStore(db);

// The App credentials are optional so the worker still runs in a development environment
// without them. What they gate is explicit rather than silent: with no credentials the
// trusted configuration cannot be read, so a pull request is recorded but never reviewed.
const appId=process.env.GITHUB_APP_ID,privateKey=process.env.GITHUB_APP_PRIVATE_KEY;
const broker=appId&&privateKey?new GitHubTokenBroker(appId,privateKey):undefined;
const config=broker?new GitHubFileSource(broker):undefined;
if(!config)console.log(JSON.stringify({event:'worker.no_github_app',message:'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are absent; events are recorded but no review run is created.'}));

// Anything a previous process left behind is removed before new work is taken, so content
// never outlives a crash by longer than one restart (ADR-038).
// Cloud execution needs three things a deployment may legitimately not have: keys to decrypt
// a stored provider credential, App credentials to clone, and a Bedrock region if Bedrock is
// the provider. What is missing is said once at startup, and a cloud run is then refused with
// a named reason rather than silently running somewhere else.
const cipher=cipherFromEnvironment();
const deployment={bedrockRegion:process.env.HUMANIZE_BEDROCK_REGION,ollamaBaseUrl:process.env.HUMANIZE_CLOUD_OLLAMA_BASE_URL};
const cloudEnabled=Boolean(cipher&&broker);
if(!cloudEnabled)console.log(JSON.stringify({event:'worker.no_cloud_execution',
  message:'HUMANIZE_ENCRYPTION_KEYS and the GitHub App credentials are required to execute a cloud review; cloud runs are refused until both are configured.'}));

const swept=await publications.sweep();
if(swept)console.log(JSON.stringify({event:'publication.swept',count:swept}));

await queue.work('github.event',async payload=>{
  // The delivery holds the event; the job carries only identifiers, never content.
  const delivery=await db.pool.query<{metadata:unknown}>('SELECT metadata FROM webhook_deliveries WHERE delivery_id=$1',[payload.traceId]);
  const metadata=delivery.rows[0]?.metadata;
  if(metadata===undefined||metadata===null)return;
  const outcome=await handleGitHubEvent(GitHubEventSchema.parse(metadata),{
    db,runs,administration,
    scheduler:{enqueue:async next=>{await queue.send('pull_request.review',next);}},
    // Without App credentials the worker still records events; it simply cannot read the
    // trusted configuration, so no review run is created and that is visible in the outcome.
    ...(config?{config}:{}),
  });
  console.log(JSON.stringify({event:'github.event.handled',action:outcome.action,traceId:payload.traceId}));
});

await queue.work('pull_request.review',async payload=>{
  const outcome=await dispatchReview(payload,{
    async run(organizationId,runId){
      // The snapshot is JSONB and therefore untrusted shape here; dispatchReview parses it
      // against ReviewSnapshotSchema before reading anything from it.
      const rows=await db.pool.query<{organization_id:string;repository_id:string;id:string;state:string;attempt:number;snapshot:ReviewSnapshot}>(
        'SELECT organization_id,repository_id,id,state,attempt,snapshot FROM review_runs WHERE organization_id=$1 AND id=$2',[organizationId,runId]);
      const row=rows.rows[0];
      if(!row)return null;
      return {organizationId:row.organization_id,repositoryId:row.repository_id,runId:row.id,
        state:row.state,attempt:row.attempt,snapshot:row.snapshot};
    },
    runners:{enqueue:async(organizationId,repositoryId,runId)=>{await runners.enqueue(organizationId,repositoryId,runId);}},
    // Present only when this deployment can actually execute one; absent, dispatchReview
    // reports cloud_execution_unavailable instead of queueing work nothing will take.
    ...(cloudEnabled?{cloud:{enqueue:async record=>{await queue.send('review.cloud_execute',{version:1,
      organizationId:record.organizationId,repositoryId:record.repositoryId,runId:record.runId,
      traceId:record.runId,idempotencyKey:`cloud:${record.runId}`});}}}:{}),
    queued:async record=>{await runs.transition({organizationId:record.organizationId,repositoryId:record.repositoryId,runId:record.runId},'RECEIVED','QUEUED',record.attempt);},
  });
  console.log(JSON.stringify({event:'pull_request.review.handled',status:outcome.status,
    ...(outcome.status==='skipped'?{reason:outcome.reason}:{runId:outcome.runId})}));
});

if(cloudEnabled)await queue.work('review.cloud_execute',async payload=>{
  const outcome=await executeCloudReview(payload,{
    async run(organizationId,runId){
      const rows=await db.pool.query<{organization_id:string;repository_id:string;id:string;state:string;attempt:number;snapshot:ReviewSnapshot}>(
        'SELECT organization_id,repository_id,id,state,attempt,snapshot FROM review_runs WHERE organization_id=$1 AND id=$2',[organizationId,runId]);
      const row=rows.rows[0];
      if(!row)return null;
      return {organizationId:row.organization_id,repositoryId:row.repository_id,runId:row.id,
        state:row.state,attempt:row.attempt,snapshot:row.snapshot};
    },
    // Scoped to the organisation that owns the run, so one tenant's reference can never
    // resolve another tenant's secret, and to the provider the profile names.
    credential:async(organizationId,provider,reference)=>
      new EncryptedSecretStore(db,cipher!,provider).resolve(organizationId,reference),
    provider:(profile,secret)=>createProvider(profile.provider,secret,deployment),
    // Read-only and single-repository: the clone needs nothing more, and the publish
    // credential is minted separately when the review is ready to post.
    async token(snapshot){
      const repo=await db.pool.query<{github_repository_id:string}>(
        'SELECT github_repository_id FROM repositories WHERE organization_id=$1 AND id=$2',
        [snapshot.organizationId,snapshot.repositoryId]);
      const githubRepositoryId=repo.rows[0]?.github_repository_id;
      if(githubRepositoryId===undefined)throw Error('REPOSITORY_UNKNOWN');
      return broker!.token(snapshot.installationId,Number(githubRepositoryId),'read');
    },
    execute:executeReview,
    // The result is held only until publication completes or is abandoned (ADR-038), and
    // the job carries identifiers alone.
    schedulePublication:async(snapshot,result)=>{
      await publications.put({runId:result.runId,organizationId:snapshot.organizationId,
        repositoryId:snapshot.repositoryId,retentionMode:snapshot.retentionMode,payload:{snapshot,result}});
      await queue.send('review.publish',{version:1,organizationId:snapshot.organizationId,
        repositoryId:snapshot.repositoryId,runId:result.runId,headSha:snapshot.headSha,
        traceId:result.runId,idempotencyKey:`publish:${result.runId}:${snapshot.headSha}`});
    },
    // What to review comes from the snapshot alone; only where to work is configured here.
    config:{},
  });
  // A retry is signalled by throwing, so pg-boss reschedules rather than marking it done.
  if(outcome.status==='retry')throw Error(outcome.errorClass);
  console.log(JSON.stringify({event:'review.cloud_execute.handled',status:outcome.status,runId:payload.runId,
    ...(outcome.status==='skipped'?{reason:outcome.reason}:{candidates:outcome.candidates,
      inspectedFiles:outcome.inspectedFiles,changedNodes:outcome.changedNodes})}));
});

await queue.work('review.publish',async payload=>{
  const outcome=await publishReview(payload,{
    publications,
    publish:async({snapshot,result})=>{
      if(!broker)throw Error('PUBLISH_TRANSPORT_UNBOUND');
      // The repository-scoped publish credential carries pull_requests and checks write, and
      // nothing else; the read token a runner holds could never post this.
      const repo=await db.pool.query<{github_repository_id:string}>(
        'SELECT github_repository_id FROM repositories WHERE organization_id=$1 AND id=$2',
        [snapshot.organizationId,snapshot.repositoryId]);
      const githubRepositoryId=repo.rows[0]?.github_repository_id;
      if(githubRepositoryId===undefined)throw Error('REPOSITORY_UNKNOWN');
      const transport=githubClient(await broker.token(snapshot.installationId,Number(githubRepositoryId),'publish'));

      // Coordinates come from GitHub, never from the runner: a compromised runner must not be
      // able to move a finding onto a line the author never wrote (INV-014).
      const diff=await fetchDiffMap(transport,{owner:snapshot.owner,repo:snapshot.repository,
        pullNumber:snapshot.pullNumber,repositoryId:snapshot.repositoryId,baseSha:snapshot.baseSha,headSha:snapshot.headSha});

      // Findings are rebuilt from the accepted result and every quotation re-checked, because
      // the runner is untrusted even after its envelope was validated.
      const findings=findingsFromResult(result,snapshot);
      // A one-click fix is a patch the author applies to their own repository, so the control
      // plane proves it against the file itself rather than trusting anything the runner sent.
      const suggested=config
        ? await attachSuggestions(findings,diff,snapshot.headSha,async filePath=>
            (await config.read({installationId:snapshot.installationId,githubRepositoryId:Number(githubRepositoryId),
              owner:snapshot.owner,name:snapshot.repository,ref:snapshot.headSha,path:filePath},LIMITS.fileBytes))?.content??null)
        : {attached:0,refused:{}};
      // The inline budget the administrator and repository settled on, never the product default.
      const plan=planPublication(findings,{maxSubjectiveInline:snapshot.review.settings.maxSubjectiveInline});
      const review=buildReview({inline:plan.inline,summary:plan.summary,diff,reviewedNodes:result.nodes.length});
      const check=buildCheck([...plan.inline,...plan.summary]);
      try{
        const posted=await new ReviewPublisher(transport).publish(
          {owner:snapshot.owner,repo:snapshot.repository,pullNumber:snapshot.pullNumber,headSha:snapshot.headSha},
          review,check);
        console.log(JSON.stringify({event:'review.published',runId:payload.runId,
          inline:review.comments.length,summary:plan.summary.length,conclusion:check.conclusion,
          suggestions:suggested.attached,suggestionsRefused:suggested.refused,
          reviewId:posted.reviewId,checkRunId:posted.checkRunId,updatedExisting:posted.updatedExisting}));
        return {reviewId:posted.reviewId};
      }catch(error){
        // A superseded head is an expected end, not a failure: a newer review replaces this one.
        if(error instanceof StaleHeadError)return {skipped:'stale_head' as const,current:error.current};
        throw error;
      }
    },
  });
  // A retry is signalled by throwing, so pg-boss reschedules rather than marking it done.
  if(outcome.status==='retry')throw Error(outcome.errorClass);
  console.log(JSON.stringify({event:'review.publish.handled',status:outcome.status,runId:payload.runId}));
});

let closing=false;
const close=async()=>{if(closing)return;closing=true;await queue.stop();await db.close();};
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
console.log(JSON.stringify({event:'worker.started',
  queues:['github.event','pull_request.review',...(cloudEnabled?['review.cloud_execute']:[]),'review.publish']}));
