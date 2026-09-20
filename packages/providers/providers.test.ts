import { expect,it,vi } from 'vitest';
import { z } from 'zod';
import { OpenAIProvider,GeminiProvider,OpenRouterProvider,OllamaProvider } from './src/index.js';
import { LIMITS } from '@humanize/domain';
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
