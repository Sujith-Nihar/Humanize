import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,migrate,RunnerStore,RunStore } from '@humanize/db';
import { RunnerClient,runLease } from '@humanize/runner';
import type { ReviewSnapshot } from '@humanize/domain';
import { createApi } from './src/app.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new RunnerStore(db),runs=new RunStore(db);
const issued={token:'ghs_fixture_token',expiresAt:'2026-09-17T21:00:00.000Z'};
const app=createApi({webhookSecret:'secret',sink:{ingest:vi.fn(async()=>true)},runners:store,tokens:{scopedToken:vi.fn(async()=>issued)}});
const capabilities={protocolVersion:1 as const,schemaVersion:'humanize-runner-v1' as const,version:'0.1.0',models:['fixture'],labels:[],localOnly:true as const};
const org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
let snapshot:ReviewSnapshot,client:RunnerClient,runnerId='',pull=0;

// Drives the real HTTP surface through Fastify's injector, so the client exercises the
// deployed routes rather than the store.
const inject:typeof globalThis.fetch=async(input,init)=>{
  const response=await app.inject({method:'POST',url:new URL(input as URL).pathname,headers:init?.headers as Record<string,string>,payload:init?.body as string});
  return new Response(response.statusCode===204?null:response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
};
const enqueue=async()=>{const run=await runs.create({...snapshot,pullNumber:++pull},1);await store.enqueue(org,repo,run);return run;};

beforeAll(async()=>{
  await migrate(db);
  await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[org,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[installation,org]);
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[repo,org,installation,randomInt(1,1000000000),'acme','site']);
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  snapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  client=new RunnerClient({controlPlaneUrl:'http://control.test/',fetch:inject});
  runnerId=await client.register(await store.enrollment(org,[repo]),capabilities);
},30000);
afterAll(async()=>{await app.close();await db.close();});

it('claims, renews and completes a job over the real protocol', async()=>{
  const run=await enqueue();
  await client.heartbeat(capabilities);
  const lease=await client.claim();
  expect(lease).toMatchObject({runId:run,fence:1});
  expect(lease!.snapshot.headSha).toBe(snapshot.headSha);
  // Remaining time is reported by the control plane, so this assertion does not depend on
  // the test process and the database agreeing about the time.
  const renewed=await client.renew(lease!.leaseId,lease!.fence);
  expect(renewed).toBeGreaterThan(0);
  expect(renewed).toBeLessThanOrEqual(120000);
  const outcome=await runLease(client,lease!,async({credential})=>{
    expect(credential.repository).toEqual({owner:'acme',name:'site'});
    return 'reviewed';
  });
  expect(outcome).toEqual({status:'completed',value:'reviewed'});
});

it('reports no work when the queue is idle', async()=>{
  expect(await client.claim()).toBeNull();
});

it('returns a retryable attempt to the queue and refuses it after the attempt budget', async()=>{
  const run=await enqueue();
  for(let attempt=1;attempt<=3;attempt++){
    const lease=await client.claim();
    expect(lease).toMatchObject({runId:run,fence:attempt});
    await client.fail(lease!.leaseId,lease!.fence,true);
  }
  // A fourth claim is refused: the lease exhausted its attempts rather than looping forever.
  expect(await client.claim()).toBeNull();
  const state=await db.pool.query<{state:string;attempts:number}>('SELECT state,attempts FROM runner_leases WHERE run_id=$1',[run]);
  expect(state.rows[0]).toMatchObject({state:'FAILED_FINAL',attempts:3});
});

it('stops a running job when the lease is cancelled by revocation', async()=>{
  await enqueue();
  const lease=await client.claim();
  const outcome=await runLease(client,lease!,async({signal})=>{
    // Revocation happens mid-job; the next renewal is the runner's cancellation signal.
    await store.revoke(org,runnerId);
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    throw signal.reason;
  },{renewIntervalMs:5,safetyMarginMs:0});
  expect(outcome).toEqual({status:'lost'});
  const state=await db.pool.query<{state:string}>('SELECT state FROM runner_leases WHERE id=$1',[lease!.leaseId]);
  expect(state.rows[0]!.state).toBe('CANCELLED');
});

it('refuses every authenticated call once the credential is revoked', async()=>{
  await expect(client.claim()).rejects.toThrow('RUNNER_UNAUTHORIZED');
  await expect(client.heartbeat(capabilities)).rejects.toThrow('RUNNER_UNAUTHORIZED');
});
