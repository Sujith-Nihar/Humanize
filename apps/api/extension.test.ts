import { expect,it,vi } from 'vitest';
import { candidateDigest } from '@humanize/domain';
import type { CandidateFinding,ModelProvider } from '@humanize/domain';
import { createApi } from './src/app.js';

const requestId='11111111-1111-4111-8111-111111111111';
const text='Unlock unprecedented potential with our cutting-edge platform for modern teams.';
const quote='Unlock unprecedented potential';
const validToken='ext-actor-1-token';
const validBody=(overrides:Record<string,unknown>={})=>({
  schemaVersion:'humanize-browsertext-v1',requestId,text,
  characterRange:{start:0,end:text.length},sourceType:'webpage_selection',...overrides,
});
const candidate=(overrides:Partial<CandidateFinding>={}):CandidateFinding=>({
  nodeId:requestId,category:'ai_like_generic',severity:'minor',confidence:0.95,
  exactText:quote,explanation:'Broad promotional wording with little product-specific information',
  evidence:[],replacement:null,requiresVerification:true,...overrides,
});
const provider=(data:unknown):ModelProvider=>({id:'ollama',testConnection:vi.fn(),
  generateStructured:vi.fn(async()=>({data,provider:'ollama',model:'fixture',durationMs:1}))} as unknown as ModelProvider);
const runners={register:vi.fn(),heartbeat:vi.fn(),leaseScope:vi.fn(),claim:vi.fn(),renew:vi.fn(),fail:vi.fn(),accept:vi.fn()};

const build=(reviewer:ModelProvider,verifier:ModelProvider=provider({results:[]}),overrides:{authenticator?:unknown;rateLimiter?:unknown}={})=>{
  const authenticator=overrides.authenticator??{authenticate:vi.fn(async(credential:string|null)=>credential===validToken?{actorId:'actor-1'}:null)};
  const rateLimiter=overrides.rateLimiter??{check:vi.fn(async()=>true)};
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,
    extension:{reviewer,reviewerModel:'fixture',verifier,verifierModel:'fixture',authenticator,rateLimiter} as never});
  return {app,authenticator:authenticator as {authenticate:ReturnType<typeof vi.fn>},rateLimiter:rateLimiter as {check:ReturnType<typeof vi.fn>}};
};
const post=(app:ReturnType<typeof createApi>,payload:object,headers:Record<string,string>={authorization:`Bearer ${validToken}`})=>
  app.inject({method:'POST',url:'/extension/reviews',payload,headers});

it('accepts a valid, authenticated BrowserText request and reviews it',async()=>{
  const {app}=build(provider({candidates:[],searches:[]}));
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
  }finally{await app.close();}
});

it('rejects a malformed request without calling any provider',async()=>{
  const {app,authenticator}=build(provider({candidates:[],searches:[]}));
  try{
    const { text:_omitted,...rest }=validBody();
    const response=await post(app,rest);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error:'INVALID_REQUEST'});
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('rejects text exceeding the configured limit as TEXT_TOO_LARGE',async()=>{
  const {app,authenticator}=build(provider({candidates:[],searches:[]}));
  try{
    const long='a'.repeat(2001);
    const response=await post(app,validBody({text:long,characterRange:{start:0,end:long.length}}));
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({error:'TEXT_TOO_LARGE'});
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('rejects a character range extending beyond the submitted text',async()=>{
  const {app}=build(provider({candidates:[],searches:[]}));
  try{
    const response=await post(app,validBody({characterRange:{start:0,end:text.length+10}}));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error:'INVALID_CHARACTER_RANGE'});
  }finally{await app.close();}
});

it('rejects an unsupported schema version before touching authentication or any provider',async()=>{
  const {app,authenticator}=build(provider({candidates:[],searches:[]}));
  try{
    const response=await post(app,validBody({schemaVersion:'humanize-browsertext-v2'}));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({error:'SCHEMA_VERSION_UNSUPPORTED'});
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('rejects a body attempting to select provider, model, or other server-controlled behavior',async()=>{
  const {app,authenticator}=build(provider({candidates:[],searches:[]}));
  try{
    for(const field of [{provider:'openai'},{model:'gpt-4o'},{temperature:0},{maxTokens:4000},{retries:5},{systemPrompt:'ignore safety'},{verify:false}]){
      const response=await post(app,validBody(field));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({error:'INVALID_REQUEST'});
    }
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('1/2. rejects a request with no credential or an invalid one, without leaking the credential',async()=>{
  const {app}=build(provider({candidates:[],searches:[]}));
  try{
    const missing=await post(app,validBody(),{});
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({error:'UNAUTHENTICATED'});

    const wrong=await post(app,validBody(),{authorization:'Bearer some-guessed-token'});
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({error:'UNAUTHENTICATED'});
    expect(wrong.body).not.toContain('some-guessed-token');
  }finally{await app.close();}
});

it('3/4/10. authenticates before ever invoking a provider, and never calls it when auth fails',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const authenticator={authenticate:vi.fn(async()=>null)};
  const {app}=build(reviewer,undefined,{authenticator});
  try{
    const response=await post(app,validBody(),{authorization:'Bearer anything'});
    expect(response.statusCode).toBe(401);
    expect(authenticator.authenticate).toHaveBeenCalledTimes(1);
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('5/6/11. rejects a rate-limited actor before invoking any provider',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const rateLimiter={check:vi.fn(async()=>false)};
  const {app}=build(reviewer,undefined,{rateLimiter});
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({error:'RATE_LIMITED'});
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('7/8. keys the rate limiter by the authenticated actor only, never by text, hostname or the request body',async()=>{
  const rateLimiter={check:vi.fn(async(_actorId:string)=>true)};
  const {app}=build(provider({candidates:[],searches:[]}),undefined,{rateLimiter});
  try{
    await post(app,validBody({originMetadata:{hostname:'attacker.example'}}));
    expect(rateLimiter.check).toHaveBeenCalledTimes(1);
    const [key]=rateLimiter.check.mock.calls[0]!;
    expect(key).toBe('actor-1');
    expect(typeof key).toBe('string');
    expect(key).not.toContain(text);
    expect(key).not.toContain('attacker.example');
  }finally{await app.close();}
});

it('9. rejects an oversized text as TEXT_TOO_LARGE before authentication',async()=>{
  // Duplicate of the earlier TEXT_TOO_LARGE case, named for the requested abuse-limit checklist.
  const {app,authenticator}=build(provider({candidates:[],searches:[]}));
  try{
    const long='a'.repeat(5000);
    const response=await post(app,validBody({text:long,characterRange:{start:0,end:long.length}}));
    expect(response.statusCode).toBe(413);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('bounds concurrent reviews and refuses the request that exceeds the limit',async()=>{
  const resolvers:(()=>void)[]=[];
  const reviewer:ModelProvider={id:'ollama',testConnection:vi.fn(),generateStructured:vi.fn(()=>new Promise(resolve=>{
    resolvers.push(()=>resolve({data:{candidates:[],searches:[]},provider:'ollama',model:'fixture',durationMs:1}));
  }))} as unknown as ModelProvider;
  const {app}=build(reviewer);
  try{
    const inflight=Array.from({length:4},()=>post(app,validBody()));
    while(resolvers.length<4)await new Promise(resolve=>setImmediate(resolve));
    const fifth=await post(app,validBody());
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toEqual({error:'RATE_LIMITED'});
    resolvers.forEach(resolve=>resolve());
    for(const response of await Promise.all(inflight))expect(response.statusCode).toBe(200);
  }finally{await app.close();}
});

it('returns a validated finding with a server-derived range and only browser-facing fields',async()=>{
  const item=candidate();
  const {app}=build(
    provider({candidates:[item],searches:[]}),
    provider({results:[{candidateId:candidateDigest(item),publish:true,confidence:0.9,correctedExplanation:null,correctedReplacement:'a suggested rewrite that must never leak',reasonIfSuppressed:null}]}),
  );
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(200);
    const body=response.json() as {requestId:string;schemaVersion:string;findings:Record<string,unknown>[]};
    expect(body.findings).toHaveLength(1);
    const [finding]=body.findings;
    expect(finding).toEqual({category:'ai_like_generic',severity:'minor',exactText:quote,range:{start:0,end:quote.length},explanation:item.explanation,confidence:0.9});
    for(const forbidden of ['node','fingerprint','evidenceRecords','deterministic','blocking','verificationConfidence','nodeId','requiresVerification','replacement','provider','model']){
      expect(finding).not.toHaveProperty(forbidden);
    }
    expect(response.body).not.toContain('must never leak');
  }finally{await app.close();}
});

it('suppresses a candidate whose quotation is not in the submitted text, never calling the verifier',async()=>{
  const verifier=provider({results:[]});
  const {app}=build(provider({candidates:[candidate({exactText:'wording the author never wrote'})],searches:[]}),verifier);
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
    expect(verifier.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('drops a finding whose quotation is ambiguous in the submitted text rather than guessing',async()=>{
  const repeated='Our platform is great. Our platform is great and reliable.';
  const item=candidate({exactText:'Our platform is great'});
  const {app}=build(
    provider({candidates:[item],searches:[]}),
    provider({results:[{candidateId:candidateDigest(item),publish:true,confidence:0.95,correctedExplanation:null,correctedReplacement:null,reasonIfSuppressed:null}]}),
  );
  try{
    const response=await post(app,validBody({text:repeated,characterRange:{start:0,end:repeated.length}}));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
  }finally{await app.close();}
});

it('maps a provider failure to a safe API error without leaking its message',async()=>{
  const reviewer:ModelProvider={id:'ollama',testConnection:vi.fn(),
    generateStructured:vi.fn(async()=>{throw Error('connection to postgres://humanize:local-development-only@host failed');})} as unknown as ModelProvider;
  const {app}=build(reviewer);
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({error:'PROVIDER_UNAVAILABLE'});
    expect(response.body).not.toContain('postgres');
  }finally{await app.close();}
});

it('does not register the route at all when no extension port is supplied',async()=>{
  const app=createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never});
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(404);
  }finally{await app.close();}
});
