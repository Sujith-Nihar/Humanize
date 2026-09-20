import { beforeAll,afterAll,beforeEach,expect,it,vi } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,migrate,RunnerStore,RunStore } from '@humanize/db';
import { createApi } from './src/app.js';
import type { ReviewSnapshot } from '@humanize/domain';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new RunnerStore(db),runs=new RunStore(db);
const issued={token:'ghs_fixture_token',expiresAt:'2026-09-17T21:00:00.000Z'};
const scopedToken=vi.fn(async()=>issued);
const app=createApi({webhookSecret:'secret',sink:{ingest:vi.fn(async()=>true)},runners:store,tokens:{scopedToken}});
const capabilities={protocolVersion:1 as const,schemaVersion:'humanize-runner-v1' as const,version:'0.1.0',models:['fixture'],labels:[],localOnly:true as const};
const org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000),githubRepositoryId=randomInt(1,1000000000);
const otherOrg=randomUUID(),otherRepo=randomUUID(),otherInstallation=randomInt(1,1000000000);
let snapshot:ReviewSnapshot,credential='',runnerId='',pull=0;

const tenant=async(organization:string,repository:string,install:number,githubId:number)=>{
  await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[organization,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[install,organization]);
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[repository,organization,install,githubId,'acme','site']);
};
const enrolled=async(organization:string,repository:string)=>store.register(await store.enrollment(organization,[repository]),capabilities);
/** Claims a fresh lease so each case starts from a live one. */
const claimed=async(runner=credential)=>{
  const run=await runs.create({...snapshot,pullNumber:++pull},1);
  await store.enqueue(org,repo,run);const lease=await store.claim(runner);
  if(!lease)throw Error('expected a lease');return lease;
};
const requestToken=(lease:{leaseId:string;fence:number},runner=credential)=>app.inject({
  method:'POST',url:`/runner/leases/${lease.leaseId}/token`,headers:{authorization:`Bearer ${runner}`},payload:{fence:lease.fence},
});

beforeAll(async()=>{
  await migrate(db);
  await tenant(org,repo,installation,githubRepositoryId);
  await tenant(otherOrg,otherRepo,otherInstallation,randomInt(1,1000000000));
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  snapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  ({credential,runnerId}=await enrolled(org,repo));
},30000);
afterAll(async()=>{await app.close();await db.close();});
beforeEach(()=>scopedToken.mockClear());

it('issues a token scoped to the single repository of a live lease',async()=>{
  const lease=await claimed();
  const response=await requestToken(lease);
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({token:issued.token,repository:{owner:'acme',name:'site'},headSha:snapshot.headSha,runId:lease.runId});
  expect(scopedToken).toHaveBeenCalledExactlyOnceWith(installation,githubRepositoryId,'read');
});

it('refuses a superseded fence and a lease belonging to another runner',async()=>{
  const lease=await claimed();
  expect((await requestToken({leaseId:lease.leaseId,fence:lease.fence+1})).statusCode).toBe(409);
  expect((await requestToken({leaseId:randomUUID(),fence:lease.fence})).statusCode).toBe(409);
  const foreign=await enrolled(otherOrg,otherRepo);
  expect((await requestToken(lease,foreign.credential)).statusCode).toBe(409);
  expect(scopedToken).not.toHaveBeenCalled();
  await store.revoke(otherOrg,foreign.runnerId);
});

it('refuses an expired lease and a lease released back to the queue',async()=>{
  const expired=await claimed();
  await db.pool.query("UPDATE runner_leases SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.leaseId]);
  expect((await requestToken(expired)).statusCode).toBe(409);
  const released=await claimed();
  await store.fail(credential,released.leaseId,released.fence,false);
  expect((await requestToken(released)).statusCode).toBe(409);
  expect(scopedToken).not.toHaveBeenCalled();
});

it('refuses a lease whose run is no longer reviewable',async()=>{
  const lease=await claimed();
  await runs.transition({organizationId:org,repositoryId:repo,runId:lease.runId},'RECEIVED','CANCELLED',0);
  expect((await requestToken(lease)).statusCode).toBe(409);
  expect(scopedToken).not.toHaveBeenCalled();
});

it('refuses a lease whose repository is disabled or whose installation is suspended',async()=>{
  const disabled=await claimed();
  await db.pool.query('UPDATE repositories SET enabled=false WHERE id=$1',[repo]);
  expect((await requestToken(disabled)).statusCode).toBe(409);
  await db.pool.query('UPDATE repositories SET enabled=true WHERE id=$1',[repo]);
  const suspended=await claimed();
  await db.pool.query('UPDATE github_installations SET suspended=true WHERE id=$1',[installation]);
  expect((await requestToken(suspended)).statusCode).toBe(409);
  await db.pool.query('UPDATE github_installations SET suspended=false WHERE id=$1',[installation]);
  expect(scopedToken).not.toHaveBeenCalled();
});

it('stops issuing tokens the moment the runner credential is revoked',async()=>{
  const lease=await claimed();
  expect((await requestToken(lease)).statusCode).toBe(201);
  await store.revoke(org,runnerId);
  const response=await requestToken(lease);
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({error:'RUNNER_UNAUTHORIZED'});
  expect(scopedToken).toHaveBeenCalledTimes(1);
});
