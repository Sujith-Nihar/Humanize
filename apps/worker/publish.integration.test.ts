import { beforeAll,afterAll,beforeEach,expect,it,vi } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,migrate,PublicationStore,RunStore } from '@humanize/db';
import type { JobPayload,ReviewSnapshot } from '@humanize/domain';
import { publishReview } from './src/publish-worker.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),publications=new PublicationStore(db);
const org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
let runId='',snapshot:ReviewSnapshot;

const result=()=>({version:1 as const,leaseId:randomUUID(),fence:1,runId,snapshotHash:'digest',
  nodes:[],candidates:[],evidence:[],verification:{results:[]},diagnostics:[]});
const job=():JobPayload=>({version:1,organizationId:org,repositoryId:repo,runId,traceId:runId,idempotencyKey:runId});
const held=async()=>(await db.pool.query('SELECT 1 FROM publication_payloads WHERE run_id=$1',[runId])).rowCount;

beforeAll(async()=>{
  await migrate(db);
  await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[org,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[installation,org]);
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[repo,org,installation,randomInt(1,1000000000),'acme','site']);
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  snapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  runId=await new RunStore(db).create(snapshot,1);
},30000);
afterAll(async()=>db.close());
beforeEach(async()=>publications.discard(org,runId));

it('publishes a held review and then removes the content it held', async () => {
  await publications.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:{snapshot,result:result()}});
  const publish=vi.fn(async()=>({reviewId:42}));
  expect(await publishReview(job(),{publications,publish})).toEqual({status:'published',reviewId:42});
  expect(publish).toHaveBeenCalledTimes(1);
  // Ephemeral retention promises no content survives the job (ADR-038).
  expect(await held()).toBe(0);
});

it('removes the content when the pull request has moved on', async () => {
  await publications.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:{snapshot,result:result()}});
  const outcome=await publishReview(job(),{publications,publish:async()=>({skipped:'stale_head' as const,current:'c'.repeat(40)})});
  expect(outcome).toEqual({status:'skipped',reason:'stale_head'});
  // A newer review supersedes this one, so the payload will never publish and must not linger.
  expect(await held()).toBe(0);
});

it('removes a payload that can never be published', async () => {
  await publications.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:{snapshot,result:{version:1,nonsense:true}}});
  const publish=vi.fn();
  expect(await publishReview(job(),{publications,publish})).toEqual({status:'skipped',reason:'invalid_payload'});
  expect(publish).not.toHaveBeenCalled();
  expect(await held()).toBe(0);
});

it('keeps the payload when a retry could still succeed', async () => {
  await publications.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:{snapshot,result:result()}});
  const outcome=await publishReview(job(),{publications,publish:async()=>{throw Error('GitHub unavailable');}});
  expect(outcome).toMatchObject({status:'retry'});
  // Discarding here would lose a review the queue is about to attempt again.
  expect(await held()).toBe(1);
  // The retry then publishes and clears it.
  expect(await publishReview(job(),{publications,publish:async()=>({reviewId:7})})).toMatchObject({status:'published'});
  expect(await held()).toBe(0);
});

it('does nothing when there is no payload to publish', async () => {
  const publish=vi.fn();
  expect(await publishReview(job(),{publications,publish})).toEqual({status:'skipped',reason:'no_payload'});
  expect(await publishReview({...job(),runId:undefined},{publications,publish})).toEqual({status:'skipped',reason:'no_payload'});
  expect(publish).not.toHaveBeenCalled();
});
