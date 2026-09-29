import { expect,it,vi } from 'vitest';
import { GitHubIdentity,githubAdminCheck } from './src/index.js';
import type { GitHubTransport,RepositoryCoordinates } from './src/index.js';

const app={clientId:'Iv1.client',clientSecret:'shh-secret'};
const json=(body:unknown,ok=true)=>({ok,json:async()=>body}) as Response;

/** A transport answering fixed routes, recording what was asked. */
function transport(routes:Record<string,unknown|((parameters:Record<string,unknown>)=>unknown)>):GitHubTransport&{calls:string[]} {
  const calls:string[]=[];
  return {calls,async request<T>(route:string,parameters:Record<string,unknown>){
    calls.push(route);
    const answer=routes[route];
    if(answer===undefined)throw Error(`unexpected ${route}`);
    return {data:(typeof answer==='function'?(answer as (p:Record<string,unknown>)=>unknown)(parameters):answer) as T};
  }};
}

it('builds an authorize URL carrying the client id and state, and nothing secret', () => {
  const identity=new GitHubIdentity({...app,redirectUrl:'https://humanize.example/auth/github/callback'},async()=>[],()=>transport({}));
  const url=new URL(identity.authorizeUrl('state-123'));
  expect(url.origin+url.pathname).toBe('https://github.com/login/oauth/authorize');
  expect(url.searchParams.get('client_id')).toBe('Iv1.client');
  expect(url.searchParams.get('state')).toBe('state-123');
  expect(url.searchParams.get('redirect_uri')).toBe('https://humanize.example/auth/github/callback');
  expect(url.toString()).not.toContain('shh-secret');
});

it('signs a user in to the organizations whose installations they can see', async () => {
  const fetcher=vi.fn(async()=>json({access_token:'ghu_user'}));
  const directory=vi.fn(async(accounts:readonly number[])=>accounts.map(account=>`org-${account}`));
  const userTransport=vi.fn(()=>transport({
    'GET /user':{id:42,login:'octo'},
    'GET /user/installations':{total_count:2,installations:[{account:{id:7}},{account:{id:9}},{account:null}]},
  }));
  const identity=new GitHubIdentity(app,directory,userTransport,fetcher as unknown as typeof fetch);
  expect(await identity.exchange('code')).toEqual({userId:'42',organizationIds:['org-7','org-9']});
  // The user's token is used for the sign-in and never returned in the identity.
  expect(userTransport).toHaveBeenCalledWith('ghu_user');
  expect(directory).toHaveBeenCalledWith([7,9]);
});

it('yields no identity for a refused, reused or failing exchange', async () => {
  const none=async()=>[];
  // GitHub reports a bad code as a 200 with an error body, so a status check alone would pass it.
  const refused=new GitHubIdentity(app,none,()=>transport({}),(async()=>json({error:'bad_verification_code'})) as unknown as typeof fetch);
  expect(await refused.exchange('reused')).toBeNull();
  const down=new GitHubIdentity(app,none,()=>transport({}),(async()=>{throw Error('ECONNRESET');}) as unknown as typeof fetch);
  expect(await down.exchange('code')).toBeNull();
  const noUser=new GitHubIdentity(app,none,()=>transport({}),(async()=>json({access_token:'ghu'})) as unknown as typeof fetch);
  expect(await noUser.exchange('code')).toBeNull();
});

const repository:RepositoryCoordinates={id:'repo-1',installationId:5,githubRepositoryId:500,owner:'acme',name:'site'};
const other:RepositoryCoordinates={id:'repo-2',installationId:5,githubRepositoryId:501,owner:'acme',name:'docs'};

it('grants only the repositories GitHub says this user administers now', async () => {
  const permissions:Record<string,string>={site:'admin',docs:'write'};
  const client=transport({
    'GET /user/{account_id}':{login:'octo'},
    'GET /repos/{owner}/{repo}/collaborators/{username}/permission':(p:Record<string,unknown>)=>({permission:permissions[p.repo as string],user:{id:42}}),
  });
  const metadata=vi.fn(async()=>client);
  const check=githubAdminCheck('42',async()=>[repository,other],metadata);
  expect(await check(['repo-1','repo-2'])).toEqual(['repo-1']);
  // Asked with the metadata-only token for each repository, never a broader one.
  expect(metadata).toHaveBeenCalledWith(5,500);
  expect(metadata).toHaveBeenCalledWith(5,501);
});

it('refuses when the answer names a different account than the session', async () => {
  // A renamed account whose old login someone else took would otherwise be checked as the
  // wrong person, and that person's admin rights would be borrowed.
  const client=transport({
    'GET /user/{account_id}':{login:'octo'},
    'GET /repos/{owner}/{repo}/collaborators/{username}/permission':{permission:'admin',user:{id:99}},
  });
  expect(await githubAdminCheck('42',async()=>[repository],async()=>client)(['repo-1'])).toEqual([]);
});

it('fails closed whenever GitHub cannot be asked', async () => {
  const failing:GitHubTransport={request:async()=>{throw Error('502');}};
  expect(await githubAdminCheck('42',async()=>[repository],async()=>failing)(['repo-1'])).toEqual([]);
  expect(await githubAdminCheck('42',async()=>{throw Error('db down');},async()=>failing)(['repo-1'])).toEqual([]);
  expect(await githubAdminCheck('42',async()=>[repository],async()=>{throw Error('token refused');})(['repo-1'])).toEqual([]);
  // A malformed session identity is never sent to GitHub at all.
  const lookup=vi.fn(async()=>[repository]);
  expect(await githubAdminCheck('not-a-number',lookup,async()=>failing)(['repo-1'])).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
});
