import { beforeAll,afterAll,expect,it } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,migrate,PublicationStore,RunStore } from './src/index.js';
import type { ReviewSnapshot } from '@humanize/domain';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new PublicationStore(db);
const org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
let runId='',snapshot:ReviewSnapshot;

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

const content={findings:[{explanation:'SOURCE_SENTINEL wording is vague'}]};

it('holds a payload only until it is taken and discarded', async () => {
  await store.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:content});
  const taken=await store.take(org,runId);
  expect(taken?.payload).toEqual(content);
  await store.discard(org,runId);
  // Publication completed, so no content survives the job (ADR-038).
  expect(await store.take(org,runId)).toBeNull();
  const remaining=await db.pool.query('SELECT 1 FROM publication_payloads WHERE run_id=$1',[runId]);
  expect(remaining.rowCount).toBe(0);
});

it('discards an abandoned payload too, because unpublishable content is still content', async () => {
  await store.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:content});
  await store.discard(org,runId);
  expect(await store.take(org,runId)).toBeNull();
});

it('sweeps a payload a crash left behind', async () => {
  await store.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:content},-1000);
  expect(await store.sweep()).toBe(1);
  expect(await store.take(org,runId)).toBeNull();
  // A payload still within its lifetime is untouched by the sweep.
  await store.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:content});
  expect(await store.sweep()).toBe(0);
  await store.discard(org,runId);
});

it('refuses a payload for a run that does not exist', async () => {
  await expect(store.put({runId:randomUUID(),organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:content})).rejects.toThrow();
});

it('isolates payloads by tenant', async () => {
  await store.put({runId,organizationId:org,repositoryId:repo,retentionMode:'ephemeral',payload:content});
  expect(await store.take(randomUUID(),runId)).toBeNull();
  await store.discard(org,runId);
});
