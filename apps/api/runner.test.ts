import { expect,it,vi } from 'vitest';
import { createApi } from './src/app.js';

const capabilities={protocolVersion:1,schemaVersion:'humanize-runner-v1',version:'0.1.0',models:['fixture'],labels:[],localOnly:true};
const token='e'.repeat(43),credential='c'.repeat(43);
const lease='11111111-1111-4111-8111-111111111111';
const scope={installationId:42,githubRepositoryId:99,owner:'acme',name:'site',headSha:'b'.repeat(40),runId:'22222222-2222-4222-8222-222222222222'};
const issued={token:'ghs_fixture_token',expiresAt:'2026-09-17T21:00:00.000Z'};
const build=(runners:Partial<{register:unknown;heartbeat:unknown;leaseScope:unknown}>={},tokens:Partial<{scopedToken:unknown}>={})=>createApi({
  webhookSecret:'secret',sink:{ingest:vi.fn(async()=>true)},
  runners:{register:vi.fn(async()=>({runnerId:'runner','credential':credential})),heartbeat:vi.fn(async()=>undefined),leaseScope:vi.fn(async()=>scope),...runners} as never,
  tokens:{scopedToken:vi.fn(async()=>issued),...tokens} as never,
});
const requestToken=(app:ReturnType<typeof createApi>,options:{id?:string;fence?:unknown;headers?:Record<string,string>}={})=>app.inject({
  method:'POST',url:`/runner/leases/${options.id??lease}/token`,
  headers:options.headers??{authorization:`Bearer ${credential}`},payload:{fence:options.fence??1},
});

it('issues a credential once for a valid enrollment and records the heartbeat',async()=>{
  const app=build();
  try{
    const registered=await app.inject({method:'POST',url:'/runner/registrations',payload:{enrollmentToken:token,capabilities}});
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toEqual({runnerId:'runner',credential});
    const beat=await app.inject({method:'POST',url:'/runner/heartbeats',headers:{authorization:`Bearer ${credential}`},payload:capabilities});
    expect(beat.statusCode).toBe(204);
  }finally{await app.close();}
});

it('refuses an incompatible protocol or schema version before touching the service',async()=>{
  const register=vi.fn(),heartbeat=vi.fn();const app=build({register,heartbeat});
  try{
    for(const broken of [{...capabilities,protocolVersion:2},{...capabilities,schemaVersion:'humanize-runner-v2'}]){
      const response=await app.inject({method:'POST',url:'/runner/registrations',payload:{enrollmentToken:token,capabilities:broken}});
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({error:'INCOMPATIBLE_PROTOCOL',protocolVersion:1,schemaVersion:'humanize-runner-v1'});
    }
    const beat=await app.inject({method:'POST',url:'/runner/heartbeats',headers:{authorization:`Bearer ${credential}`},payload:{...capabilities,protocolVersion:2}});
    expect(beat.statusCode).toBe(409);
    expect(register).not.toHaveBeenCalled();expect(heartbeat).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('rejects malformed registration bodies without reaching the service',async()=>{
  const register=vi.fn();const app=build({register});
  try{
    for(const payload of [{},{enrollmentToken:'short',capabilities},{enrollmentToken:token},{enrollmentToken:token,capabilities:{...capabilities,localOnly:false}},{enrollmentToken:token,capabilities,extra:true}]){
      expect((await app.inject({method:'POST',url:'/runner/registrations',payload})).statusCode).toBe(400);
    }
    expect(register).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('refuses a heartbeat without a well-formed bearer credential',async()=>{
  const heartbeat=vi.fn();const app=build({heartbeat});
  try{
    for(const headers of [{},{authorization:credential},{authorization:'Basic '+credential},{authorization:'Bearer short'},{authorization:'Bearer '+'!'.repeat(43)}]){
      const response=await app.inject({method:'POST',url:'/runner/heartbeats',headers,payload:capabilities});
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({error:'RUNNER_UNAUTHORIZED'});
    }
    expect(heartbeat).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('maps consumed enrollment and revoked credentials to 401 without leaking diagnostics',async()=>{
  const app=build({
    register:vi.fn(async()=>{throw Error('INVALID_ENROLLMENT');}),
    heartbeat:vi.fn(async()=>{throw Error('RUNNER_UNAUTHORIZED');}),
  });
  try{
    expect((await app.inject({method:'POST',url:'/runner/registrations',payload:{enrollmentToken:token,capabilities}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/runner/heartbeats',headers:{authorization:`Bearer ${credential}`},payload:capabilities})).statusCode).toBe(401);
  }finally{await app.close();}
});

it('returns a generic error when the store fails for any other reason',async()=>{
  const app=build({register:vi.fn(async()=>{throw Error('connection to postgres://humanize:local-development-only@host failed');})});
  try{
    const response=await app.inject({method:'POST',url:'/runner/registrations',payload:{enrollmentToken:token,capabilities}});
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({error:'RUNNER_SERVICE_UNAVAILABLE'});
    expect(response.body).not.toContain('postgres');
  }finally{await app.close();}
});

it('refuses oversized registration bodies', async()=>{
  const register=vi.fn();const app=build({register});
  try{
    const response=await app.inject({method:'POST',url:'/runner/registrations',payload:{enrollmentToken:token,capabilities,padding:'p'.repeat(16*1024)}});
    expect(response.statusCode).toBe(413);
    expect(register).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('issues a single-repository read-only token for a live lease',async()=>{
  const scopedToken=vi.fn(async()=>issued);const app=build({},{scopedToken});
  try{
    const response=await requestToken(app);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({token:issued.token,expiresAt:issued.expiresAt,repository:{owner:'acme',name:'site'},headSha:scope.headSha,runId:scope.runId});
    expect(scopedToken).toHaveBeenCalledWith(42,99,'read');
  }finally{await app.close();}
});

it('never reaches the issuer when the lease is lost, revoked or superseded',async()=>{
  const scopedToken=vi.fn();
  const app=build({leaseScope:vi.fn(async()=>{throw Error('LEASE_LOST');})},{scopedToken});
  try{
    const response=await requestToken(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({error:'LEASE_LOST'});
    expect(scopedToken).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('never reaches the issuer for an unknown runner or a malformed request',async()=>{
  const scopedToken=vi.fn(),leaseScope=vi.fn(async()=>{throw Error('RUNNER_UNAUTHORIZED');});
  const app=build({leaseScope},{scopedToken});
  try{
    expect((await requestToken(app,{headers:{}})).statusCode).toBe(401);
    expect((await requestToken(app,{headers:{authorization:'Bearer short'}})).statusCode).toBe(401);
    expect(leaseScope).not.toHaveBeenCalled();
    for(const options of [{id:'not-a-uuid'},{id:'1'.repeat(64)},{fence:0},{fence:-1},{fence:'1'},{fence:1.5}]){
      expect((await requestToken(app,options)).statusCode).toBe(400);
    }
    // A traversal attempt does not resolve to the route at all.
    expect((await requestToken(app,{id:'../../admin'})).statusCode).toBe(404);
    expect(leaseScope).not.toHaveBeenCalled();
    expect((await requestToken(app)).statusCode).toBe(401);
    expect(scopedToken).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('does not expose issuer failures or leak a token on error',async()=>{
  const app=build({},{scopedToken:vi.fn(async()=>{throw Error('GitHub rejected app private key ghs_secret');})});
  try{
    const response=await requestToken(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({error:'RUNNER_SERVICE_UNAVAILABLE'});
    expect(response.body).not.toContain('ghs_');
  }finally{await app.close();}
});
