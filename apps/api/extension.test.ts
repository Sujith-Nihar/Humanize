import { expect,it,vi } from 'vitest';
import { candidateDigest } from '@humanize/domain';
import type { CandidateFinding,ModelProvider } from '@humanize/domain';
import { createApi } from './src/app.js';

const requestId='11111111-1111-4111-8111-111111111111';
const text='Unlock unprecedented potential with our cutting-edge platform for modern teams.';
const quote='Unlock unprecedented potential';
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
const build=(reviewer:ModelProvider,verifier:ModelProvider=provider({results:[]}))=>
  createApi({webhookSecret:'s',sink:{ingest:vi.fn(async()=>true)},runners:runners as never,tokens:{scopedToken:vi.fn()} as never,
    extension:{reviewer,reviewerModel:'fixture',verifier,verifierModel:'fixture'}});
const post=(app:ReturnType<typeof createApi>,payload:object)=>app.inject({method:'POST',url:'/extension/reviews',payload});

it('1. accepts a valid BrowserText request and reviews it',async()=>{
  const app=build(provider({candidates:[],searches:[]}));
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
  }finally{await app.close();}
});

it('2. rejects a malformed request without calling any provider',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const app=build(reviewer);
  try{
    const { text:_omitted,...rest }=validBody();
    const response=await post(app,rest);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error:'INVALID_REQUEST'});
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('3. rejects text exceeding the configured limit as TEXT_TOO_LARGE',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const app=build(reviewer);
  try{
    const long='a'.repeat(2001);
    const response=await post(app,validBody({text:long,characterRange:{start:0,end:long.length}}));
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({error:'TEXT_TOO_LARGE'});
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('4. rejects a character range extending beyond the submitted text',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const app=build(reviewer);
  try{
    const response=await post(app,validBody({characterRange:{start:0,end:text.length+10}}));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({error:'INVALID_CHARACTER_RANGE'});
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('5. rejects an unsupported schema version before touching any provider',async()=>{
  const reviewer=provider({candidates:[],searches:[]});
  const app=build(reviewer);
  try{
    const response=await post(app,validBody({schemaVersion:'humanize-browsertext-v2'}));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({error:'SCHEMA_VERSION_UNSUPPORTED'});
    expect(reviewer.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('6/7/10. returns a validated finding with a server-derived range and only browser-facing fields',async()=>{
  const item=candidate();
  const app=build(
    provider({candidates:[item],searches:[]}),
    provider({results:[{candidateId:candidateDigest(item),publish:true,confidence:0.9,correctedExplanation:null,correctedReplacement:'a suggested rewrite that must never leak',reasonIfSuppressed:null}]}),
  );
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(200);
    const body=response.json() as {requestId:string;schemaVersion:string;findings:Record<string,unknown>[]};
    expect(body.findings).toHaveLength(1);
    const [finding]=body.findings;
    // The range is derived from the text the server holds, never asserted by the model.
    expect(finding).toEqual({category:'ai_like_generic',severity:'minor',exactText:quote,range:{start:0,end:quote.length},explanation:item.explanation,confidence:0.9});
    for(const forbidden of ['node','fingerprint','evidenceRecords','deterministic','blocking','verificationConfidence','nodeId','requiresVerification','replacement','provider','model']){
      expect(finding).not.toHaveProperty(forbidden);
    }
    expect(response.body).not.toContain('must never leak');
  }finally{await app.close();}
});

it('8. suppresses a candidate whose quotation is not in the submitted text, never calling the verifier',async()=>{
  const verifier=provider({results:[]});
  const app=build(provider({candidates:[candidate({exactText:'wording the author never wrote'})],searches:[]}),verifier);
  try{
    const response=await post(app,validBody());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
    expect(verifier.generateStructured).not.toHaveBeenCalled();
  }finally{await app.close();}
});

it('9. drops a finding whose quotation is ambiguous in the submitted text rather than guessing',async()=>{
  const repeated='Our platform is great. Our platform is great and reliable.';
  const item=candidate({exactText:'Our platform is great'});
  const app=build(
    provider({candidates:[item],searches:[]}),
    provider({results:[{candidateId:candidateDigest(item),publish:true,confidence:0.95,correctedExplanation:null,correctedReplacement:null,reasonIfSuppressed:null}]}),
  );
  try{
    const response=await post(app,validBody({text:repeated,characterRange:{start:0,end:repeated.length}}));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({requestId,schemaVersion:'humanize-browsertext-v1',findings:[]});
  }finally{await app.close();}
});

it('11. maps a provider failure to a safe API error without leaking its message',async()=>{
  const reviewer:ModelProvider={id:'ollama',testConnection:vi.fn(),
    generateStructured:vi.fn(async()=>{throw Error('connection to postgres://humanize:local-development-only@host failed');})} as unknown as ModelProvider;
  const app=build(reviewer);
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
