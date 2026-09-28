import { expect,it,vi } from 'vitest';
import { z } from 'zod';
import { OpenAIProvider,GeminiProvider,OpenRouterProvider,OllamaProvider,BedrockProvider,bedrockSchema } from './src/index.js';
import { LIMITS,ReviewerResponseSchema } from '@humanize/domain';
const args={model:'test-model',system:'policy',input:'untrusted source',schema:z.object({ok:z.boolean()}).strict(),timeoutMs:5000,traceContext:{traceId:'trace'}};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

it('normalizes the same structured result across all four providers',async()=>{
  const openai=vi.fn<typeof fetch>(async()=>json({status:'completed',model:'test-model',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}]}));
  const gemini=vi.fn<typeof fetch>(async()=>json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"ok":true}'}]}}]}));
  const router=vi.fn<typeof fetch>(async()=>json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
  const ollama=vi.fn<typeof fetch>(async url=>String(url).endsWith('/api/tags')?json({models:[{name:'test-model',size:100,digest:'a'.repeat(64)}]}):json({model:'test-model',done:true,message:{content:'{"ok":true}'}}));
  const adapters=[new OpenAIProvider('secret',{fetch:openai}),new GeminiProvider('secret',{fetch:gemini}),new OpenRouterProvider('secret',[],{fetch:router}),new OllamaProvider('http://localhost:11434',true,{fetch:ollama})];
  for(const adapter of adapters)expect((await adapter.generateStructured(args)).data).toEqual({ok:true});
  const body=JSON.parse(String(router.mock.calls[0]?.[1]?.body));expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false});
  expect(openai.mock.calls[0]?.[1]?.redirect).toBe('error');
  expect(String(openai.mock.calls[0]?.[1]?.body)).not.toContain('secret');
});
it('repairs malformed output once and never returns invalid data',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not json'}]}]}));
  await expect(new OpenAIProvider('secret',{fetch:transport}).generateStructured(args)).rejects.toMatchObject({code:'INVALID_OUTPUT'});
  expect(transport).toHaveBeenCalledTimes(2);
});
it('does not retry refusal and redacts provider error bodies',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>json({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}));
  await expect(new OpenAIProvider('secret',{fetch:transport}).generateStructured(args)).rejects.toMatchObject({code:'REFUSAL'});expect(transport).toHaveBeenCalledTimes(1);
  await expect(new GeminiProvider('secret',{fetch:async()=>new Response('SECRET_SOURCE',{status:401})}).generateStructured(args)).rejects.toThrow('AUTH');
});
it('bounds transport retries and supports cancellation',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>new Response('down',{status:503}));
  await expect(new OpenAIProvider('secret',{fetch:transport,retryDelayMs:0}).generateStructured(args)).rejects.toMatchObject({code:'TRANSPORT'});expect(transport).toHaveBeenCalledTimes(3);
  const signal=AbortSignal.abort();await expect(new OpenAIProvider('secret',{fetch:transport}).generateStructured({...args,signal})).rejects.toMatchObject({code:'CANCELLED'});
});
it('rejects cloud-backed Ollama models before sending source',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>json({models:[{name:'test-model',size:100,digest:'a'.repeat(64),remote_host:'https://cloud.example'}]}));
  await expect(new OllamaProvider('http://localhost:11434',true,{fetch:transport}).generateStructured(args)).rejects.toMatchObject({code:'MODEL_UNAVAILABLE'});
  expect(transport).toHaveBeenCalledTimes(1);
});

it('asks Ollama for a context window that covers the whole budgeted request', async () => {
  const calls:{url:string;body:Record<string,unknown>}[]=[];
  const transport=vi.fn<typeof fetch>(async(url,init)=>{
    const target=String(url);
    if(target.endsWith('/api/tags'))return json({models:[{name:'test-model',size:100,digest:'a'.repeat(64)}]});
    if(target.endsWith('/api/show'))return json({capabilities:['completion']});
    calls.push({url:target,body:JSON.parse(String(init?.body)) as Record<string,unknown>});
    return json({model:'test-model',done:true,message:{content:'{"ok":true}'}});
  });
  const provider=new OllamaProvider('http://localhost:11434',true,{fetch:transport});
  await provider.generateStructured({model:'test-model',system:'s',input:'i',schema:z.object({ok:z.boolean()}),timeoutMs:5000,traceContext:{traceId:'t'}});
  const options=calls[0]!.body.options as Record<string,number>;
  // Truncation would evict the system prompt, which carries the untrusted-content boundary.
  expect(options.num_ctx!).toBeGreaterThanOrEqual(LIMITS.contextTokens+LIMITS.outputTokens);
  expect(options.num_predict!).toBeLessThanOrEqual(options.num_ctx!);
  expect(options.temperature).toBe(0);
});

it('disables reasoning only for a model that supports it, so the output budget reaches the answer', async () => {
  const bodies:Record<string,unknown>[]=[];
  const transport=(capabilities:string[])=>vi.fn<typeof fetch>(async(url,init)=>{
    const target=String(url);
    if(target.endsWith('/api/tags'))return json({models:[{name:'test-model',size:100,digest:'a'.repeat(64)}]});
    if(target.endsWith('/api/show'))return json({capabilities});
    bodies.push(JSON.parse(String(init?.body)) as Record<string,unknown>);
    return json({model:'test-model',done:true,message:{content:'{"ok":true}'}});
  });
  const call=async(capabilities:string[])=>{
    await new OllamaProvider('http://localhost:11434',true,{fetch:transport(capabilities)})
      .generateStructured({model:'test-model',system:'s',input:'i',schema:z.object({ok:z.boolean()}),timeoutMs:5000,traceContext:{traceId:'t'}});
    return bodies.at(-1)!;
  };
  // Reasoning tokens compete with the answer inside one bounded budget.
  expect(await call(['completion','thinking'])).toMatchObject({think:false});
  // `think` is only valid for a model that declares the capability.
  expect(await call(['completion'])).not.toHaveProperty('think');
});

// Amazon Bedrock Converse (ADR-041).
const converse=(value:{text?:string;stopReason?:string})=>json({output:{message:{role:'assistant',content:[{text:value.text??'{"ok":true}'}]}},stopReason:value.stopReason??'end_turn',usage:{inputTokens:12,outputTokens:3}});
const UNSUPPORTED=['minLength','maxLength','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','maxItems','pattern','format'];
const keysOf=(value:unknown):string[]=>value===null||typeof value!=='object'?[]:Object.entries(value).flatMap(([key,entry])=>[key,...keysOf(entry)]);

it('sends Bedrock a Converse request on a fixed regional endpoint with the key only in the header',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>converse({}));
  const result=await new BedrockProvider('bedrock-secret','us-east-1',{fetch:transport}).generateStructured({...args,model:'us.anthropic.claude-sonnet-4-5-20250929-v1:0'});
  expect(result).toMatchObject({data:{ok:true},provider:'bedrock',usage:{inputTokens:12,outputTokens:3}});
  const [url,init]=transport.mock.calls[0]!;
  // The model id is one path segment, so it cannot address another resource.
  expect(String(url)).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse');
  expect(init?.redirect).toBe('error');
  expect((init?.headers as Record<string,string>).authorization).toBe('Bearer bedrock-secret');
  expect(String(init?.body)).not.toContain('bedrock-secret');
  const body=JSON.parse(String(init?.body));
  expect(body.system).toEqual([{text:'policy'}]);
  expect(body.messages).toEqual([{role:'user',content:[{text:'untrusted source'}]}]);
  expect(body.outputConfig.textFormat.type).toBe('json_schema');
  expect(JSON.parse(body.outputConfig.textFormat.structure.jsonSchema.schema)).toMatchObject({type:'object',properties:{ok:{type:'boolean'}}});
});

it('refuses a Bedrock region that could point the request anywhere else',()=>{
  for(const region of ['','us-east-1.evil.example','evil.example/x','US-EAST-1','us-east-1#'])
    expect(()=>new BedrockProvider('secret',region),region).toThrow('PERMISSION');
  expect(()=>new BedrockProvider('','us-east-1')).toThrow('AUTH');
  expect(()=>new BedrockProvider('secret','us-gov-west-1')).not.toThrow();
});

it('strips schema keywords Bedrock rejects, while local validation still enforces them',async()=>{
  const sent=bedrockSchema(z.toJSONSchema(ReviewerResponseSchema,{target:'draft-7',io:'output'}));
  expect(keysOf(sent).filter(key=>UNSUPPORTED.includes(key))).toEqual([]);
  expect(JSON.stringify(sent)).toContain('"additionalProperties":false');
  // A value Bedrock was never told to bound is still refused locally, then repaired once.
  const bounded={...args,schema:z.object({ok:z.string().max(3)}).strict()};
  const transport=vi.fn<typeof fetch>(async()=>converse({text:'{"ok":"far too long"}'}));
  await expect(new BedrockProvider('secret','us-east-1',{fetch:transport}).generateStructured(bounded)).rejects.toMatchObject({code:'INVALID_OUTPUT'});
  expect(transport).toHaveBeenCalledTimes(2);
});

it('normalizes Bedrock stop reasons without retrying refusals or overflows',async()=>{
  const call=async(stopReason:string)=>{
    const transport=vi.fn<typeof fetch>(async()=>converse({stopReason}));
    const error=await new BedrockProvider('secret','us-east-1',{fetch:transport}).generateStructured(args).catch(caught=>caught);
    return {code:error.code,calls:transport.mock.calls.length};
  };
  expect(await call('guardrail_intervened')).toEqual({code:'REFUSAL',calls:1});
  expect(await call('content_filtered')).toEqual({code:'REFUSAL',calls:1});
  expect(await call('max_tokens')).toEqual({code:'CONTEXT_LIMIT',calls:1});
  expect(await call('model_context_window_exceeded')).toEqual({code:'CONTEXT_LIMIT',calls:1});
  // Malformed output is repaired once, like every other adapter.
  expect(await call('malformed_model_output')).toEqual({code:'INVALID_OUTPUT',calls:2});
});

it('retries Bedrock model errors and throttling but not access or validation failures',async()=>{
  const call=async(status:number)=>{
    const transport=vi.fn<typeof fetch>(async()=>new Response('{"message":"SECRET_SOURCE"}',{status}));
    const error=await new BedrockProvider('secret','us-east-1',{fetch:transport,retryDelayMs:0}).generateStructured(args).catch(caught=>caught);
    expect(String(error.message)).not.toContain('SECRET_SOURCE');
    return {code:error.code,calls:transport.mock.calls.length};
  };
  expect(await call(424)).toEqual({code:'TRANSPORT',calls:3});
  expect(await call(503)).toEqual({code:'TRANSPORT',calls:3});
  expect(await call(429)).toEqual({code:'RATE_LIMIT',calls:3});
  expect(await call(403)).toEqual({code:'PERMISSION',calls:1});
  expect(await call(404)).toEqual({code:'MODEL_UNAVAILABLE',calls:1});
  // A schema or model that does not support structured output is a capability gap, not a retry.
  expect(await call(400)).toEqual({code:'UNSUPPORTED_CAPABILITY',calls:1});
});

it('passes the application-shaped capability probe through Bedrock',async()=>{
  const transport=vi.fn<typeof fetch>(async(_url,init)=>{
    const schema=JSON.parse(JSON.parse(String(init?.body)).outputConfig.textFormat.structure.jsonSchema.schema);
    return converse({text:schema.properties?.candidates?'{"candidates":[],"searches":[]}':'{"ok":true}'});
  });
  expect(await new BedrockProvider('secret','us-east-1',{fetch:transport}).testConnection('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toMatchObject({provider:'bedrock',structuredOutput:true});
  expect(transport).toHaveBeenCalledTimes(2);
});
