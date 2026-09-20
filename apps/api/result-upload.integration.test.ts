import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { randomUUID,randomInt } from 'node:crypto';
import { Database,migrate,RunnerStore,RunStore } from '@humanize/db';
import { snapshotDigest } from '@humanize/domain';
import type { ContentNode,ReviewSnapshot,RunnerResult } from '@humanize/domain';
import { createApi } from './src/app.js';

const url=process.env.HUMANIZE_TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.endsWith('/humanize_test'))throw Error('Disposable test database required');
const db=new Database(url),store=new RunnerStore(db),runs=new RunStore(db);
const app=createApi({webhookSecret:'secret',sink:{ingest:vi.fn(async()=>true)},runners:store,tokens:{scopedToken:vi.fn(async()=>({token:'ghs_fixture',expiresAt:'2026-09-17T21:00:00.000Z'}))}});
const capabilities={protocolVersion:1 as const,schemaVersion:'humanize-runner-v1' as const,version:'0.1.0',models:['fixture'],labels:[],localOnly:true as const};
const org=randomUUID(),repo=randomUUID(),installation=randomInt(1,1000000000),otherOrg=randomUUID(),otherRepo=randomUUID(),otherInstallation=randomInt(1,1000000000);
let snapshot:ReviewSnapshot,credential='',pull=0;

const upload=(leaseId:string,body:unknown,runner=credential)=>app.inject({method:'POST',url:`/runner/leases/${leaseId}/result`,headers:{authorization:`Bearer ${runner}`},payload:body as never});
const claimed=async(runner=credential)=>{
  const run=await runs.create({...snapshot,pullNumber:++pull},1);
  await store.enqueue(org,repo,run);const lease=await store.claim(runner);
  if(!lease)throw Error('expected a lease');return lease;
};
const node=(headSha:string):ContentNode=>({id:'node-1',repositoryId:repo,commitSha:headSha,filePath:'app/page.tsx',blobSha:'d'.repeat(40),parser:'babel',parserVersion:'1',startLine:1,endLine:1,startOffset:0,endOffset:30,text:'Unlock unprecedented potential',normalizedText:'unlock unprecedented potential',kind:'heading',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config-hash',suggestionSafe:true});
const envelope=(lease:{leaseId:string;fence:number;runId:string;snapshot:ReviewSnapshot},overrides:Partial<RunnerResult>={}):RunnerResult=>({
  version:1,leaseId:lease.leaseId,fence:lease.fence,runId:lease.runId,snapshotHash:snapshotDigest(JSON.parse(JSON.stringify(lease.snapshot))),
  nodes:[node(lease.snapshot.headSha)],
  candidates:[{nodeId:'node-1',category:'ai_like_generic',severity:'minor',confidence:0.9,exactText:'Unlock unprecedented potential',explanation:'Broad promotional wording',evidence:[],replacement:null,requiresVerification:true}],
  evidence:[],verification:{results:[]},diagnostics:[],...overrides,
});

beforeAll(async()=>{
  await migrate(db);
  for(const [organization,repository,install] of [[org,repo,installation],[otherOrg,otherRepo,otherInstallation]] as const){
    await db.pool.query('INSERT INTO organizations(id,github_account_id) VALUES($1,$2)',[organization,randomInt(1,1000000000)]);
    await db.pool.query('INSERT INTO github_installations(id,organization_id) VALUES($1,$2)',[install,organization]);
    await db.pool.query('INSERT INTO repositories(id,organization_id,installation_id,github_repository_id,owner,name,enabled) VALUES($1,$2,$3,$4,$5,$6,true)',[repository,organization,install,randomInt(1,1000000000),'acme','site']);
  }
  const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
  snapshot={version:1,organizationId:org,repositoryId:repo,installationId:installation,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
  ({credential}=await store.register(await store.enrollment(org,[repo]),capabilities));
},30000);
afterAll(async()=>{await app.close();await db.close();});

it('accepts a consistent result once and treats an identical re-send as a duplicate',async()=>{
  const lease=await claimed();
  const first=await upload(lease.leaseId,envelope(lease));
  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual({accepted:true,duplicate:false});
  expect((await upload(lease.leaseId,envelope(lease))).json()).toEqual({accepted:true,duplicate:true});
  const stored=await db.pool.query<{state:string;result_hash:string}>('SELECT state,result_hash FROM runner_leases WHERE id=$1',[lease.leaseId]);
  expect(stored.rows[0]!.state).toBe('RESULT_RECEIVED');
  // Only the digest is retained; no extracted content reaches the lease row.
  expect(JSON.stringify(stored.rows[0])).not.toContain('Unlock unprecedented');
});

it('rejects a second, different result for the same lease',async()=>{
  const lease=await claimed();
  expect((await upload(lease.leaseId,envelope(lease))).statusCode).toBe(200);
  const conflicting=await upload(lease.leaseId,envelope(lease,{diagnostics:[{code:'PARSER_FAILED',count:1}]}));
  expect(conflicting.statusCode).toBe(409);
  expect(conflicting.json()).toEqual({error:'CONFLICTING_RESULT'});
});

it('rejects a result whose content was not extracted at the reviewed commit',async()=>{
  const lease=await claimed();
  const stale=await upload(lease.leaseId,envelope(lease,{nodes:[node('f'.repeat(40))]}));
  expect(stale.statusCode).toBe(422);
  expect(stale.json()).toMatchObject({error:'INVALID_RESULT',violations:['NODE_NOT_AT_HEAD']});
  // Nothing was stored, so the lease is still open for a correct submission.
  expect((await upload(lease.leaseId,envelope(lease))).statusCode).toBe(200);
});

it('rejects a fabricated quote and never echoes the payload back',async()=>{
  const lease=await claimed();
  const fabricated=await upload(lease.leaseId,envelope(lease,{candidates:[{nodeId:'node-1',category:'ai_like_generic',severity:'major',confidence:0.99,exactText:'wording the developer never wrote',explanation:'Invented',evidence:[],replacement:null,requiresVerification:false}]}));
  expect(fabricated.statusCode).toBe(422);
  expect(fabricated.json()).toMatchObject({violations:['CANDIDATE_TEXT_NOT_IN_NODE']});
  expect(fabricated.body).not.toContain('never wrote');
});

it('rejects a stale fence, a foreign runner and a mismatched snapshot digest',async()=>{
  const lease=await claimed();
  expect((await upload(lease.leaseId,envelope({...lease,fence:lease.fence+1}))).statusCode).toBe(409);
  expect((await upload(lease.leaseId,envelope(lease,{snapshotHash:snapshotDigest({...snapshot,headSha:'c'.repeat(40)})}))).statusCode).toBe(409);
  const foreign=await store.register(await store.enrollment(otherOrg,[otherRepo]),capabilities);
  expect((await upload(lease.leaseId,envelope(lease),foreign.credential)).statusCode).toBe(409);
  await store.revoke(otherOrg,foreign.runnerId);
});

it('rejects a result submitted after the lease expired, and a malformed or misaddressed envelope',async()=>{
  const lease=await claimed();
  await db.pool.query("UPDATE runner_leases SET expires_at=now()-interval '1 second' WHERE id=$1",[lease.leaseId]);
  expect((await upload(lease.leaseId,envelope(lease))).statusCode).toBe(409);
  expect((await upload(lease.leaseId,{version:1})).statusCode).toBe(400);
  // An envelope addressed to a different lease than the route is refused before any lookup.
  expect((await upload(lease.leaseId,envelope({...lease,leaseId:randomUUID()}))).statusCode).toBe(400);
});

it('refuses an oversized upload before parsing it',async()=>{
  const lease=await claimed();
  const text='Unlock unprecedented potential '.repeat(100);
  const huge={...envelope(lease),nodes:Array.from({length:4000},(_,index)=>({...node(snapshot.headSha),id:`node-${index}`,text,normalizedText:text.toLowerCase(),endOffset:text.length}))};
  expect(JSON.stringify(huge).length).toBeGreaterThan(8*1024*1024);
  expect((await upload(lease.leaseId,huge)).statusCode).toBe(413);
  // The lease is untouched, so the runner can still submit a result within the budget.
  expect((await upload(lease.leaseId,envelope(lease))).statusCode).toBe(200);
});
