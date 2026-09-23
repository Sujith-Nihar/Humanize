import { expect,it,vi } from 'vitest';
import type { ModelProvider } from '@humanize/domain';
import { OllamaProvider } from '@humanize/providers';
import { createApi } from './src/app.js';
import { createDevExtensionAuthenticator,createInMemoryRateLimiter,resolveExtensionPorts } from './src/extension-dev.js';

const requestId='11111111-1111-4111-8111-111111111111';
const text='Unlock unprecedented potential with our cutting-edge platform for modern teams.';
const validBody=(overrides:Record<string,unknown>={})=>({
  schemaVersion:'humanize-browsertext-v1',requestId,text,
  characterRange:{start:0,end:text.length},sourceType:'webpage_selection',...overrides,
});
const provider=(data:unknown):ModelProvider=>({id:'ollama',testConnection:vi.fn(),
  generateStructured:vi.fn(async()=>({data,provider:'ollama',model:'fixture',durationMs:1}))} as unknown as ModelProvider);
const runners={register:vi.fn(),heartbeat:vi.fn(),leaseScope:vi.fn(),claim:vi.fn(),renew:vi.fn(),fail:vi.fn(),accept:vi.fn()};

it('1/2. resolves no ports at all when no development credential is configured — fails closed',()=>{
  expect(resolveExtensionPorts({},provider({candidates:[],searches:[]}))).toBeUndefined();
  expect(resolveExtensionPorts({model:'llama3.2'},provider({candidates:[],searches:[]}))).toBeUndefined();
});

it('2. a malformed OLLAMA_BASE_URL cannot affect startup when apps/api/src/main.ts skips constructing it',()=>{
  // This is the exact hazard the conditional construction in main.ts removes: constructing
  // OllamaProvider unconditionally on every startup would throw on a bad OLLAMA_BASE_URL even
  // when the extension development path is disabled, failing the whole control plane for an
  // unrelated feature. main.ts itself has no real-DB-free unit test, matching every other app's
  // main.ts in this repository, so this test pins the underlying premise directly: the
  // constructor genuinely throws on a malformed value, which is exactly why main.ts's
  // `devCredential ? resolveExtensionPorts(..., new OllamaProvider(...)) : undefined` must never
  // evaluate the OllamaProvider branch when devCredential is absent.
  expect(()=>new OllamaProvider('not a valid url',true)).toThrow();
  // The absent-credential path resolves without ever needing a provider at all.
  expect(resolveExtensionPorts({},provider({candidates:[],searches:[]}))).toBeUndefined();
});

it('refuses to start rather than silently honouring a development credential in production',()=>{
  expect(()=>resolveExtensionPorts({devCredential:'secret',model:'llama3.2',nodeEnv:'production'},provider({candidates:[],searches:[]})))
    .toThrow('HUMANIZE_EXTENSION_DEV_CREDENTIAL must not be set when NODE_ENV=production');
});

it('refuses to resolve ports when a credential is configured but no model is named',()=>{
  expect(()=>resolveExtensionPorts({devCredential:'secret',nodeEnv:'development'},provider({candidates:[],searches:[]})))
    .toThrow('HUMANIZE_EXTENSION_MODEL is required');
});

it('4. resolves usable ports when a development credential and model are both configured outside production',()=>{
  const ports=resolveExtensionPorts({devCredential:'secret',model:'llama3.2',nodeEnv:'development'},provider({candidates:[],searches:[]}));
  expect(ports).toBeDefined();
  expect(ports?.reviewerModel).toBe('llama3.2');
  expect(ports?.verifierModel).toBe('llama3.2');
});

it('3/4. authenticates the exact configured credential and rejects anything else, including no credential at all',async()=>{
  const authenticator=createDevExtensionAuthenticator('correct-dev-secret');
  expect(await authenticator.authenticate('correct-dev-secret')).toEqual({actorId:'dev-actor'});
  expect(await authenticator.authenticate('wrong-guess')).toBeNull();
  expect(await authenticator.authenticate(null)).toBeNull();
});

it('the in-memory limiter allows up to its bound per actor and then rejects, resetting after the window',async()=>{
  vi.useFakeTimers();
  try{
    const limiter=createInMemoryRateLimiter({maxRequests:2,windowMs:1000});
    expect(await limiter.check('actor-1')).toBe(true);
    expect(await limiter.check('actor-1')).toBe(true);
    expect(await limiter.check('actor-1')).toBe(false);
    // A different actor has its own independent budget.
    expect(await limiter.check('actor-2')).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(await limiter.check('actor-1')).toBe(true);
  }finally{vi.useRealTimers();}
});

it('1/5. wires the route into a real createApi instance, and an authenticated request reaches review',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  // Known good in this test: schemaVersion/nodeEnv/model are all valid, so resolveExtensionPorts
  // cannot return undefined here.
  const extension=resolveExtensionPorts({devCredential:'correct-dev-secret',model:'llama3.2',nodeEnv:'development'},reviewer)!;
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,extension});
  try{
    const response=await app.inject({method:'POST',url:'/extension/reviews',payload:validBody(),headers:{authorization:'Bearer correct-dev-secret'}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
    expect(reviewer.generateStructured).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
});

it('6. an incorrect credential returns 401 and never reaches the reviewer',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const extension=resolveExtensionPorts({devCredential:'correct-dev-secret',model:'llama3.2',nodeEnv:'development'},reviewer)!;
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,extension});
  try{
    const response=await app.inject({method:'POST',url:'/extension/reviews',payload:validBody(),headers:{authorization:'Bearer wrong-guess'}});
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({error:'UNAUTHENTICATED'});
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
    // Missing entirely is refused the same way.
    const missing=await app.inject({method:'POST',url:'/extension/reviews',payload:validBody()});
    expect(missing.statusCode).toBe(401);
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('7. a rate-limited actor never reaches the reviewer',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const extension={
    reviewer,reviewerModel:'llama3.2',verifier:reviewer,verifierModel:'llama3.2',
    authenticator:createDevExtensionAuthenticator('correct-dev-secret'),
    rateLimiter:createInMemoryRateLimiter({maxRequests:1,windowMs:60_000}),
  };
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,extension});
  try{
    const headers={authorization:'Bearer correct-dev-secret'};
    const first=await app.inject({method:'POST',url:'/extension/reviews',payload:validBody(),headers});
    expect(first.statusCode).toBe(200);
    const second=await app.inject({method:'POST',url:'/extension/reviews',payload:validBody(),headers});
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({error:'RATE_LIMITED'});
    expect(reviewer.generateStructured).toHaveBeenCalledTimes(1);
  }finally{await app.close();}
});
