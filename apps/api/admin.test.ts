import { expect,it,vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SessionSigner } from '@humanize/security';
import { createApi } from './src/app.js';

const sessions=new SessionSigner(randomBytes(32));
const runners={register:vi.fn(),heartbeat:vi.fn(),leaseScope:vi.fn(),claim:vi.fn(),renew:vi.fn(),fail:vi.fn(),accept:vi.fn()};
const build=(overrides:{exchange?:unknown;credentials?:unknown}={})=>{
  const saved:{provider:string;secret:string}[]=[];
  const credentials={
    save:vi.fn(async(_org:string,provider:string,secret:string)=>{saved.push({provider,secret});return {id:'cred-1'};}),
    list:vi.fn(async()=>[{id:'cred-1',provider:'openai',createdAt:'2026-09-18T00:00:00.000Z',revokedAt:null}]),
    revoke:vi.fn(async()=>undefined),
    ...(overrides.credentials as object??{}),
  };
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,
    admin:{sessions,secureCookies:false,credentials:credentials as never,
      identity:{authorizeUrl:(state:string)=>`https://github.com/login/oauth/authorize?state=${state}`,
        exchange:(overrides.exchange as never)??vi.fn(async()=>({userId:'user-1',organizationIds:['org-a']}))}}});
  return {app,credentials,saved};
};
const cookie=(response:{headers:Record<string,unknown>},name:string):string=>{
  const header=String(response.headers['set-cookie']??'');
  return decodeURIComponent(header.split(';')[0]!.replace(`${name}=`,''));
};
const session=(organizationIds:string[]=['org-a'])=>`humanize_session=${encodeURIComponent(sessions.issue('user-1',organizationIds))}`;

it('refuses a callback that cannot present the state the sign-in issued', async () => {
  const {app}=build();
  try{
    const started=await app.inject({method:'GET',url:'/auth/github/start'});
    const state=cookie(started as never,'humanize_oauth_state');
    expect(started.json().authorizeUrl).toContain(state);
    // A callback forged by another site has no matching cookie.
    expect((await app.inject({method:'GET',url:`/auth/github/callback?code=c&state=${state}`})).statusCode).toBe(400);
    expect((await app.inject({method:'GET',url:'/auth/github/callback?code=c',headers:{cookie:`humanize_oauth_state=${state}`}})).statusCode).toBe(400);
    expect((await app.inject({method:'GET',url:'/auth/github/callback?code=c&state=wrong',headers:{cookie:`humanize_oauth_state=${state}`}})).statusCode).toBe(400);
    const accepted=await app.inject({method:'GET',url:`/auth/github/callback?code=c&state=${state}`,headers:{cookie:`humanize_oauth_state=${state}`}});
    expect(accepted.statusCode).toBe(200);
    // The session cookie is not readable by page scripts.
    expect(String(accepted.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(accepted.headers['set-cookie'])).toContain('SameSite=Lax');
  }finally{await app.close();}
});

it('refuses a sign-in the identity provider rejects', async () => {
  const {app}=build({exchange:vi.fn(async()=>null)});
  try{
    const started=await app.inject({method:'GET',url:'/auth/github/start'});
    const state=cookie(started as never,'humanize_oauth_state');
    const response=await app.inject({method:'GET',url:`/auth/github/callback?code=bad&state=${state}`,headers:{cookie:`humanize_oauth_state=${state}`}});
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  }finally{await app.close();}
});

it('never returns a saved secret, through any endpoint', async () => {
  const {app,saved}=build();
  try{
    const created=await app.inject({method:'POST',url:'/api/credentials',headers:{cookie:session()},payload:{organizationId:'org-a',provider:'openai',secret:'sk-SENTINEL-VALUE'}});
    expect(created.statusCode).toBe(201);
    expect(saved[0]!.secret).toBe('sk-SENTINEL-VALUE');
    // One-way ingress: the save is confirmed, the value is not echoed (ADR-035).
    expect(created.body).not.toContain('SENTINEL');
    const listed=await app.inject({method:'GET',url:'/api/credentials?organizationId=org-a',headers:{cookie:session()}});
    expect(listed.json().credentials[0]).toMatchObject({id:'cred-1',provider:'openai'});
    expect(listed.body).not.toContain('SENTINEL');
  }finally{await app.close();}
});

it('keeps one organization out of another organization data', async () => {
  const {app,credentials}=build();
  try{
    for(const request of [
      {method:'POST' as const,url:'/api/credentials',payload:{organizationId:'org-b',provider:'openai' as const,secret:'sk-other-tenant'}},
      {method:'GET' as const,url:'/api/credentials?organizationId=org-b'},
      {method:'DELETE' as const,url:'/api/credentials/cred-1?organizationId=org-b'},
    ]){
      const response=await app.inject({...request,headers:{cookie:session(['org-a'])}});
      expect(response.statusCode).toBe(403);
    }
    expect(credentials.save).not.toHaveBeenCalled();
    expect(credentials.revoke).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('refuses an absent, tampered or expired session', async () => {
  const {app}=build();
  try{
    expect((await app.inject({method:'GET',url:'/api/session'})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/credentials?organizationId=org-a'})).statusCode).toBe(401);
    const tampered=`humanize_session=${encodeURIComponent(sessions.issue('user-1',['org-a']).slice(0,-4)+'aaaa')}`;
    expect((await app.inject({method:'GET',url:'/api/credentials?organizationId=org-a',headers:{cookie:tampered}})).statusCode).toBe(401);
    const stale=new SessionSigner(randomBytes(32),-1000);
    expect((await app.inject({method:'GET',url:'/api/session',headers:{cookie:`humanize_session=${encodeURIComponent(stale.issue('user-1',['org-a']))}`}})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/session',headers:{cookie:session()}})).json()).toMatchObject({userId:'user-1'});
  }finally{await app.close();}
});

it('revokes a credential the session may administer', async () => {
  const {app,credentials}=build();
  try{
    expect((await app.inject({method:'DELETE',url:'/api/credentials/cred-1?organizationId=org-a',headers:{cookie:session()}})).statusCode).toBe(204);
    expect(credentials.revoke).toHaveBeenCalledWith('org-a','cred-1');
  }finally{await app.close();}
});

it('exposes repository enablement and policy only to a member of that organization', async () => {
  const setEnabled=vi.fn(async(_org:string,ids:readonly string[])=>[...ids]);
  const setPolicy=vi.fn(async()=>undefined);
  const repositories={
    repositories:vi.fn(async()=>[{id:'11111111-1111-4111-8111-111111111111',owner:'acme',name:'site',enabled:false}]),
    setEnabled,policy:vi.fn(async()=>({executionMode:'runner'})),setPolicy,
  };
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,
    admin:{sessions,secureCookies:false,identity:{authorizeUrl:()=>'x',exchange:vi.fn()},
      credentials:{save:vi.fn(),list:vi.fn(async()=>[]),revoke:vi.fn()},repositories}});
  const id='11111111-1111-4111-8111-111111111111';
  try{
    expect((await app.inject({method:'GET',url:'/api/repositories?organizationId=org-a',headers:{cookie:session()}})).json().repositories).toHaveLength(1);
    const enabled=await app.inject({method:'POST',url:'/api/repositories/enabled',headers:{cookie:session()},payload:{organizationId:'org-a',repositoryIds:[id],enabled:true}});
    expect(enabled.json()).toEqual({changed:[id],requested:1});
    expect((await app.inject({method:'GET',url:'/api/policy?organizationId=org-a',headers:{cookie:session()}})).json().policy).toMatchObject({executionMode:'runner'});
    expect((await app.inject({method:'PUT',url:'/api/policy',headers:{cookie:session()},payload:{organizationId:'org-a',policy:{executionMode:'cloud'}}})).statusCode).toBe(204);

    // Another organization is refused on every route, and the store is never reached.
    setEnabled.mockClear();setPolicy.mockClear();
    for(const request of [
      {method:'GET' as const,url:'/api/repositories?organizationId=org-b'},
      {method:'POST' as const,url:'/api/repositories/enabled',payload:{organizationId:'org-b',repositoryIds:[id],enabled:true}},
      {method:'GET' as const,url:'/api/policy?organizationId=org-b'},
      {method:'PUT' as const,url:'/api/policy',payload:{organizationId:'org-b',policy:{}}},
    ])expect((await app.inject({...request,headers:{cookie:session(['org-a'])}})).statusCode).toBe(403);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(setPolicy).not.toHaveBeenCalled();
    // An unsigned caller is refused before anything else is considered.
    expect((await app.inject({method:'GET',url:'/api/repositories?organizationId=org-a'})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/repositories/enabled',headers:{cookie:session()},payload:{organizationId:'org-a',repositoryIds:['not-a-uuid'],enabled:true}})).statusCode).toBe(400);
  }finally{await app.close();}
});
