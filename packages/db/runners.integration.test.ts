import { beforeAll,afterAll,it,expect } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { opaqueToken } from '@humanize/security';
import { Database,migrate,RunnerStore,RunStore } from './src/index.js';
import { snapshotDigest } from '@humanize/domain';
import type { ReviewSnapshot,RunnerResult } from '@humanize/domain';
import type { Lease } from './src/runners.js';
const url=process.env.HUMANIZE_TEST_DATABASE_URL;if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new RunnerStore(db),org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000);
const otherOrg=randomUUID(),otherRepo=randomUUID(),otherInstallation=randomInt(1,1000000000);
const capabilities={protocolVersion:1 as const,schemaVersion:'humanize-runner-v1' as const,version:'0.1.0',models:['fixture'],labels:[],localOnly:true as const};
let credential='',runnerId='',runId='',lease:Lease|null=null;let snapshot:ReviewSnapshot;
// PostgreSQL JSONB re-orders object keys, so equivalent payloads must still digest equally.
const reorder=<T>(value:T):T=>Array.isArray(value)?value.map(reorder) as T:value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])) as T:value;
const envelope=(lease:Lease,overrides:Partial<RunnerResult>={}):RunnerResult=>({version:1,leaseId:lease.leaseId,fence:lease.fence,runId:lease.runId,snapshotHash:snapshotDigest(JSON.parse(JSON.stringify(lease.snapshot))),nodes:[],candidates:[],evidence:[],verification:{results:[]},diagnostics:[],...overrides});
beforeAll(async()=>{
  await migrate(db);await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[org,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[installation,org]);
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[repo,org,installation,randomInt(1,1000000000),'fixture','fixture']);
  await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[otherOrg,randomInt(1,1000000000)]);
  await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[otherInstallation,otherOrg]);
  await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[otherRepo,otherOrg,otherInstallation,randomInt(1,1000000000),'fixture','other']);
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  snapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'fixture',repository:'fixture',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'a'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  runId=await new RunStore(db).create(snapshot,1);
});
afterAll(async()=>db.close());
it('consumes enrollment exactly once under concurrent registration',async()=>{
  const token=await store.enrollment(org,[repo]);const outcomes=await Promise.allSettled([store.register(token,capabilities),store.register(token,capabilities)]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const value=outcomes.find(r=>r.status==='fulfilled');if(value?.status!=='fulfilled')throw Error('missing registration');credential=value.value.credential;runnerId=value.value.runnerId;
});
it('fences expired leases and rejects old renewal',async()=>{
  await store.enqueue(org,repo,runId);const first=await store.claim(credential);expect(first).not.toBeNull();expect(await store.claim(credential)).toBeNull();
  await db.pool.query("UPDATE runner_leases SET expires_at=now()-interval '1 second' WHERE id=$1",[first!.leaseId]);
  const second=await store.claim(credential);expect(second!.fence).toBe(first!.fence+1);lease=second;
  await expect(store.renew(credential,first!.leaseId,first!.fence)).rejects.toThrow('LEASE_LOST');
  expect(await store.renew(credential,second!.leaseId,second!.fence)).toBeTruthy();
});
it('accepts a result whose snapshot digest survives the JSONB round trip',async()=>{
  const stored=(await db.pool.query<{snapshot:Record<string,unknown>}>('SELECT snapshot FROM review_runs WHERE id=$1',[runId])).rows[0]!.snapshot;
  expect(Object.keys(stored)).not.toEqual(Object.keys(lease!.snapshot));
  const result=envelope(lease!);
  expect(snapshotDigest(stored)).toBe(result.snapshotHash);
  expect((await store.accept(credential,result)).duplicate).toBe(false);
  expect((await db.pool.query<{result_hash:string;state:string}>('SELECT result_hash,state FROM runner_leases WHERE id=$1',[lease!.leaseId])).rows[0]).toMatchObject({state:'RESULT_RECEIVED'});
});
it('treats a re-sent identical result as idempotent and a changed one as conflicting',async()=>{
  expect((await store.accept(credential,reorder(envelope(lease!)))).duplicate).toBe(true);
  await expect(store.accept(credential,envelope(lease!,{diagnostics:[{code:'PARSER_FAILED',count:1}]}))).rejects.toThrow('CONFLICTING_RESULT');
});
it('rejects a mismatched snapshot digest, a stale fence and a foreign run',async()=>{
  await expect(store.accept(credential,envelope(lease!,{snapshotHash:snapshotDigest({...snapshot,headSha:'c'.repeat(40)})}))).rejects.toThrow('LEASE_MISMATCH');
  await expect(store.accept(credential,envelope(lease!,{fence:lease!.fence+1}))).rejects.toThrow('LEASE_MISMATCH');
  await expect(store.accept(credential,envelope(lease!,{runId:randomUUID()}))).rejects.toThrow('LEASE_MISMATCH');
});
it('decides lease expiry by the database clock, not this process clock',async()=>{
  const expiring=await new RunStore(db).create({...snapshot,pullNumber:9},1);
  await store.enqueue(org,repo,expiring);const claimed=await store.claim(credential);
  expect(claimed!.expiresInMs).toBeGreaterThan(0);
  expect(claimed!.expiresInMs).toBeLessThanOrEqual(120000);
  // A process clock running far behind the database must not revive an expired lease, and a
  // clock running far ahead must not kill a live one: the database owns the comparison.
  const realNow=Date.now;
  await db.pool.query("UPDATE runner_leases SET expires_at=now()-interval '1 second' WHERE id=$1",[claimed!.leaseId]);
  try{
    Date.now=()=>realNow()-60*60*1000;
    await expect(store.accept(credential,envelope(claimed!))).rejects.toThrow('LEASE_LOST');
    await db.pool.query("UPDATE runner_leases SET expires_at=now()+interval '120 seconds' WHERE id=$1",[claimed!.leaseId]);
    Date.now=()=>realNow()+60*60*1000;
    expect((await store.accept(credential,envelope(claimed!))).duplicate).toBe(false);
  }finally{Date.now=realNow;}
});
it('rejects a result submitted after the lease expired',async()=>{
  const expiring=await new RunStore(db).create({...snapshot,pullNumber:2},1);
  await store.enqueue(org,repo,expiring);const claimed=await store.claim(credential);expect(claimed!.runId).toBe(expiring);
  await db.pool.query("UPDATE runner_leases SET expires_at=now()-interval '1 second' WHERE id=$1",[claimed!.leaseId]);
  await expect(store.accept(credential,envelope(claimed!))).rejects.toThrow('LEASE_LOST');
});
it('gives concurrent claims one fenced lease each',async()=>{
  // Reclaimed expired leases stay claimable, so drain the queue before asserting exclusivity.
  for(let pending=await store.claim(credential);pending;pending=await store.claim(credential))await store.fail(credential,pending.leaseId,pending.fence,false);
  const queued=await new RunStore(db).create({...snapshot,pullNumber:3},1);await store.enqueue(org,repo,queued);
  const claims=await Promise.all([store.claim(credential),store.claim(credential)]);
  const granted=claims.filter(claim=>claim!==null);
  expect(granted).toHaveLength(1);
  expect(granted[0]!.runId).toBe(queued);
  expect(granted[0]!.fence).toBeGreaterThan(0);
  const stored=await db.pool.query<{fence:number;attempts:number;state:string}>('SELECT fence,attempts,state FROM runner_leases WHERE run_id=$1',[queued]);
  expect(stored.rows[0]).toMatchObject({fence:granted[0]!.fence,attempts:1,state:'LEASED'});
  await store.fail(credential,granted[0]!.leaseId,granted[0]!.fence,false);
});
it('keeps runners of one tenant away from another tenant work',async()=>{
  const token=await store.enrollment(otherOrg,[otherRepo]);const foreign=await store.register(token,capabilities);
  const queued=await new RunStore(db).create({...snapshot,pullNumber:4},1);await store.enqueue(org,repo,queued);
  expect(await store.claim(foreign.credential)).toBeNull();
  await expect(store.accept(foreign.credential,envelope(lease!))).rejects.toThrow('LEASE_MISMATCH');
  await expect(store.renew(foreign.credential,lease!.leaseId,lease!.fence)).rejects.toThrow('LEASE_LOST');
  await expect(store.heartbeat(opaqueToken(),capabilities)).rejects.toThrow('RUNNER_UNAUTHORIZED');
  await store.revoke(otherOrg,foreign.runnerId);
});
it('revokes identity and live leases immediately',async()=>{
  await store.revoke(org,runnerId);await expect(store.heartbeat(credential,capabilities)).rejects.toThrow('RUNNER_UNAUTHORIZED');await expect(store.claim(credential)).rejects.toThrow('RUNNER_UNAUTHORIZED');
});
it('refuses enrollment scopes outside the organization',async()=>{
  await expect(store.enrollment(org,[])).rejects.toThrow('INVALID_SCOPE');
  await expect(store.enrollment(org,[repo,repo])).rejects.toThrow('INVALID_SCOPE');
  await expect(store.enrollment(org,[randomUUID()])).rejects.toThrow('INVALID_SCOPE');
  await expect(store.enrollment(org,[otherRepo])).rejects.toThrow('INVALID_SCOPE');
});
it('refuses expired and already consumed enrollment tokens',async()=>{
  const token=await store.enrollment(org,[repo]);
  await db.pool.query("UPDATE runner_enrollments SET expires_at=now()-interval '1 second' WHERE organization_id=$1 AND consumed_at IS NULL",[org]);
  await expect(store.register(token,capabilities)).rejects.toThrow('INVALID_ENROLLMENT');
  await expect(store.register(opaqueToken(),capabilities)).rejects.toThrow('INVALID_ENROLLMENT');
});
