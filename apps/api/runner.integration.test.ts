import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,migrate,RunnerStore } from '@humanize/db';
import { opaqueToken } from '@humanize/security';
import { createApi } from './src/app.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new RunnerStore(db);
// Identity endpoints must never mint a GitHub credential, so the issuer fails if reached.
const scopedToken=vi.fn(async()=>{throw Error('issuer must not be reached');});
const app=createApi({webhookSecret:'secret',sink:{ingest:vi.fn(async()=>true)},runners:store,tokens:{scopedToken}});
const capabilities={protocolVersion:1,schemaVersion:'humanize-runner-v1',version:'0.1.0',models:['fixture'],labels:[],localOnly:true};
const org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
const otherOrg=randomUUID(),otherRepo=randomUUID(),otherInstallation=randomInt(1,1000000000);
const register=(enrollmentToken:string)=>app.inject({method:'POST',url:'/runner/registrations',payload:{enrollmentToken,capabilities}});
const heartbeat=(credential:string)=>app.inject({method:'POST',url:'/runner/heartbeats',headers:{authorization:`Bearer ${credential}`},payload:capabilities});

beforeAll(async()=>{
  await migrate(db);
  for(const [organization,repository,install] of [[org,repo,installation],[otherOrg,otherRepo,otherInstallation]] as const){
    await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[organization,randomInt(1,1000000000)]);
    await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[install,organization]);
    await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[repository,organization,install,randomInt(1,1000000000),'fixture','fixture']);
  }
},30000);
afterAll(async()=>{expect(scopedToken).not.toHaveBeenCalled();await app.close();await db.close();});

it('registers a runner over HTTP and stores only the credential hash',async()=>{
  const response=await register(await store.enrollment(org,[repo]));
  expect(response.statusCode).toBe(201);
  const {runnerId,credential}=response.json<{runnerId:string;credential:string}>();
  expect((await heartbeat(credential)).statusCode).toBe(204);
  const stored=await db.pool.query<{credential_hash:string;age_ms:string}>("SELECT credential_hash,extract(epoch from (now()-last_heartbeat))*1000 AS age_ms FROM runners WHERE id=$1",[runnerId]);
  expect(stored.rows[0]!.credential_hash).not.toContain(credential);
  // Measured entirely by the database clock; a host/database skew must not fail this.
  expect(Number(stored.rows[0]!.age_ms)).toBeLessThan(30000);
});

it('consumes an enrollment token exactly once across concurrent HTTP registrations',async()=>{
  const token=await store.enrollment(org,[repo]);
  const responses=await Promise.all([register(token),register(token)]);
  expect(responses.filter(response=>response.statusCode===201)).toHaveLength(1);
  expect(responses.filter(response=>response.statusCode===401)).toHaveLength(1);
  expect((await register(token)).statusCode).toBe(401);
});

it('refuses expired and unknown enrollment tokens over HTTP',async()=>{
  const token=await store.enrollment(org,[repo]);
  await db.pool.query("UPDATE runner_enrollments SET expires_at=now()-interval '1 second' WHERE organization_id=$1 AND consumed_at IS NULL",[org]);
  expect((await register(token)).statusCode).toBe(401);
  expect((await register(opaqueToken())).statusCode).toBe(401);
});

it('stops accepting a revoked credential and never accepts a forged one',async()=>{
  const {runnerId,credential}=(await register(await store.enrollment(org,[repo]))).json<{runnerId:string;credential:string}>();
  expect((await heartbeat(credential)).statusCode).toBe(204);
  await store.revoke(org,runnerId);
  expect((await heartbeat(credential)).statusCode).toBe(401);
  expect((await heartbeat(opaqueToken())).statusCode).toBe(401);
});

it('keeps an enrollment token of one tenant from covering another tenant repository',async()=>{
  await expect(store.enrollment(org,[otherRepo])).rejects.toThrow('INVALID_SCOPE');
  const foreign=(await register(await store.enrollment(otherOrg,[otherRepo]))).json<{credential:string}>();
  const scoped=await db.pool.query<{organization_id:string;repository_ids:string[]}>('SELECT organization_id,repository_ids FROM runners WHERE credential_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1');
  expect(scoped.rows[0]).toMatchObject({organization_id:otherOrg,repository_ids:[otherRepo]});
  expect((await heartbeat(foreign.credential)).statusCode).toBe(204);
});
