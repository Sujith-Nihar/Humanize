import { beforeAll,afterAll,expect,it } from 'vitest';
import { randomInt } from 'node:crypto';
import { Database,migrate } from '@humanize/db';
import type { GitHubEvent,JobPayload } from '@humanize/domain';
import { handleGitHubEvent } from './src/handlers.js';
import type { EventContext } from './src/handlers.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url);
const accountId=randomInt(1,1000000000),installationId=randomInt(1,1000000000),githubRepositoryId=randomInt(1,1000000000);
let organizationId='';

const event=(overrides:Partial<GitHubEvent>={}):GitHubEvent=>({
  event:'pull_request',action:'opened',installationId,accountId,accountLogin:'acme',
  repository:{githubId:githubRepositoryId,owner:'acme',name:'site',defaultBranch:'main'},
  pull:{number:7,headSha:'b'.repeat(40),baseSha:'a'.repeat(40),baseRef:'main',draft:false,state:'open'},
  ref:null,after:null,occurredAt:'2026-09-18T12:00:00.000Z',addedRepositoryIds:[],removedRepositoryIds:[],...overrides,
});

beforeAll(async()=>{
  await migrate(db);
  const organization=await db.pool.query<{id:string}>('INSERT INTO organizations(github_account_id) VALUES($1) RETURNING id',[accountId]);
  organizationId=organization.rows[0]!.id;
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[installationId,organizationId]);
},30000);
afterAll(async()=>db.close());

it('records a repository but refuses to review one nobody enabled', async () => {
  expect(await handleGitHubEvent(event(),{db})).toMatchObject({action:'ignored',reason:'repository_disabled'});
  const stored=await db.pool.query<{id:string}>('SELECT id FROM repositories WHERE github_repository_id=$1',[githubRepositoryId]);
  expect(stored.rowCount).toBe(1);
  await db.pool.query('UPDATE repositories SET enabled=true WHERE github_repository_id=$1',[githubRepositoryId]);
});

it('schedules a review for a reviewable action and advances the generation on a new head', async () => {
  expect(await handleGitHubEvent(event(),{db})).toMatchObject({action:'review_scheduled',pullNumber:7,generation:1});
  // A redelivery of the same event must not advance anything.
  expect(await handleGitHubEvent(event(),{db})).toMatchObject({generation:1});
  const pushed=event({action:'synchronize',pull:{...event().pull!,headSha:'c'.repeat(40)},occurredAt:'2026-09-18T12:05:00.000Z'});
  expect(await handleGitHubEvent(pushed,{db})).toMatchObject({action:'review_scheduled',headSha:'c'.repeat(40),generation:2});
});

it('ignores an older event that arrives after a newer one', async () => {
  const stale=event({action:'synchronize',pull:{...event().pull!,headSha:'b'.repeat(40)},occurredAt:'2026-09-18T11:00:00.000Z'});
  // Reordered delivery must not drag the pull request back to a head it has moved past.
  expect(await handleGitHubEvent(stale,{db})).toMatchObject({action:'ignored',reason:'superseded_by_newer_event'});
  const current=await db.pool.query<{head_sha:string;generation:number}>('SELECT head_sha,generation FROM pull_requests WHERE repository_id=(SELECT id FROM repositories WHERE github_repository_id=$1)',[githubRepositoryId]);
  expect(current.rows[0]).toMatchObject({head_sha:'c'.repeat(40),generation:2});
});

it('skips drafts and non-reviewable actions', async () => {
  expect(await handleGitHubEvent(event({pull:{...event().pull!,draft:true},occurredAt:'2026-09-18T13:00:00.000Z'}),{db})).toMatchObject({action:'ignored',reason:'draft'});
  expect(await handleGitHubEvent(event({action:'labeled',occurredAt:'2026-09-18T13:00:00.000Z'}),{db})).toMatchObject({action:'ignored',reason:'action_labeled'});
  // Marking a draft ready is exactly when review should begin.
  expect(await handleGitHubEvent(event({action:'ready_for_review',pull:{...event().pull!,draft:true},occurredAt:'2026-09-18T13:30:00.000Z'}),{db})).toMatchObject({action:'review_scheduled'});
});

it('never lets a reordered event revive access that was removed', async () => {
  await handleGitHubEvent(event({event:'installation',action:'deleted',repository:null,pull:null,occurredAt:'2026-09-18T14:00:00.000Z'}),{db});
  const deleted=await db.pool.query<{deleted:boolean}>('SELECT deleted FROM github_installations WHERE id=$1',[installationId]);
  expect(deleted.rows[0]!.deleted).toBe(true);
  // A redelivered creation must not restore an installation the user removed.
  await handleGitHubEvent(event({event:'installation',action:'created',repository:null,pull:null,occurredAt:'2026-09-18T13:00:00.000Z'}),{db});
  const after=await db.pool.query<{deleted:boolean}>('SELECT deleted FROM github_installations WHERE id=$1',[installationId]);
  expect(after.rows[0]!.deleted).toBe(true);
});

it('creates a review run from configuration read at the base commit, and enqueues it once', async () => {
  const { RunStore } = await import('@humanize/db');
  const reads: string[] = [];
  const enqueued: JobPayload[] = [];
  const policy = async () => ({
    retentionMode: 'ephemeral' as const, executionMode: 'runner' as const,
    reviewer: { provider: 'ollama' as const, model: 'local' }, verifier: { provider: 'ollama' as const, model: 'local' },
    allowDrafts: false, maxSubjectiveInline: 5,
    permittedCategories: ['ai_like_generic' as const, 'clarity' as const], requiredBlockingRules: [],
  });
  const context: EventContext = {
    db, runs: new RunStore(db), policy, scheduler: { enqueue: async payload => { enqueued.push(payload); } },
    config: {
      read: async args => {
        reads.push(`${args.ref}:${args.path}`);
        return { content: 'version: 1\ncomments:\n  max_subjective_inline: 2\n', sha: 'f'.repeat(40) };
      },
    },
  };
  const opened = event({ action: 'synchronize', pull: { ...event().pull!, headSha: 'd'.repeat(40) }, occurredAt: '2026-09-18T15:00:00.000Z' });
  const first = await handleGitHubEvent(opened, context);
  expect(first).toMatchObject({ action: 'review_scheduled', headSha: 'd'.repeat(40) });
  expect(first.action === 'review_scheduled' && first.runId).toBeTruthy();
  // Configuration is read from the base ref, never the head the pull request controls.
  expect(reads).toEqual([`main:${'.humanize.yml'}`]);
  expect(enqueued).toHaveLength(1);

  const stored = await db.pool.query<{ state: string; snapshot: { executionMode: string; configSha: string } }>(
    'SELECT state,snapshot FROM review_runs WHERE id=$1', [first.action === 'review_scheduled' ? first.runId : '']);
  expect(stored.rows[0]).toMatchObject({ state: 'RECEIVED' });
  // Execution and retention come from administrator policy, never from the repository file.
  expect(stored.rows[0]!.snapshot.executionMode).toBe('runner');
  expect(stored.rows[0]!.snapshot.configSha).toBe('f'.repeat(40));

  // A redelivery reuses the same run and does not enqueue a second review.
  const again = await handleGitHubEvent(opened, context);
  expect(again.action === 'review_scheduled' && again.runId).toBe(first.action === 'review_scheduled' ? first.runId : undefined);
  expect(enqueued).toHaveLength(2);
  expect(enqueued[0]!.idempotencyKey).toBe(enqueued[1]!.idempotencyKey);
});

it('reads administrator policy from storage, and refuses to guess when none is set', async () => {
  const { AdministrationStore, RunStore } = await import('@humanize/db');
  const administration = new AdministrationStore(db);
  const context: EventContext = {
    db, runs: new RunStore(db), administration,
    scheduler: { enqueue: async () => undefined },
    config: { read: async () => null },
  };
  const opened = event({ action: 'synchronize', pull: { ...event().pull!, headSha: 'e'.repeat(40) }, occurredAt: '2026-09-18T16:00:00.000Z' });

  // A review must not run on settings nobody chose.
  expect(await handleGitHubEvent(opened, context)).toMatchObject({ action: 'ignored', reason: 'no_organization_policy' });

  await administration.setPolicy(organizationId, {
    retentionMode: 'indexed', executionMode: 'cloud',
    reviewer: { provider: 'openai', model: 'gpt-review' }, verifier: { provider: 'openai', model: 'gpt-verify' },
    allowDrafts: false, maxSubjectiveInline: 3, permittedCategories: ['clarity'], requiredBlockingRules: [],
  });
  const scheduled = await handleGitHubEvent({ ...opened, occurredAt: '2026-09-18T16:05:00.000Z' }, context);
  expect(scheduled).toMatchObject({ action: 'review_scheduled' });
  const stored = await db.pool.query<{ snapshot: { executionMode: string; retentionMode: string; reviewer: { model: string } } }>(
    'SELECT snapshot FROM review_runs WHERE id=$1', [scheduled.action === 'review_scheduled' ? scheduled.runId : '']);
  // The stored policy, not a default, governs the review.
  expect(stored.rows[0]!.snapshot).toMatchObject({ executionMode: 'cloud', retentionMode: 'indexed' });
  expect(stored.rows[0]!.snapshot.reviewer.model).toBe('gpt-review');

  // A policy that no longer satisfies its schema is treated as absent, never patched.
  await administration.setPolicy(organizationId, { executionMode: 'cloud' });
  expect(await handleGitHubEvent({ ...opened, occurredAt: '2026-09-18T16:10:00.000Z' }, context)).toMatchObject({ reason: 'no_organization_policy' });
});
