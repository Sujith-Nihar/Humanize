import { z } from 'zod';
import { LIMITS } from '@humanize/domain';
import type { ModelRequest,EmbedRequest,EmbedResult } from '@humanize/domain';
import { JsonProvider,envelope,repairSystem } from './base.js';
import type { AdapterOptions,Decoded } from './base.js';
import { ProviderError } from './errors.js';
const ResponseSchema=z.object({model:z.string(),done:z.boolean(),done_reason:z.string().optional(),message:z.object({content:z.string()}),prompt_eval_count:z.number().optional(),eval_count:z.number().optional()});
const TagsSchema=z.object({models:z.array(z.object({name:z.string(),size:z.number(),digest:z.string(),remote_model:z.string().optional(),remote_host:z.string().optional()}))});
const ShowSchema=z.object({capabilities:z.array(z.string()).optional()});
export class OllamaProvider extends JsonProvider {
  readonly id='ollama' as const;
  private readonly base:string;
  private readonly contextTokens:number;
  private readonly thinkingModels=new Map<string,boolean>();
  private readonly thinking:boolean;
  constructor(baseUrl:string,private readonly localOnlyConfirmed:boolean,options:AdapterOptions={}) {
    super(options);const url=new URL(baseUrl);
    // Ollama defaults to a small context window and silently discards the overflow. Chat
    // truncation drops the oldest messages first, which is the system prompt: the untrusted
    // content boundary would be evicted while the repository text it governs survives. The
    // window must therefore cover the whole budgeted request, not just the prompt we expect.
    this.contextTokens=Math.max(options.contextTokens??0,LIMITS.contextTokens+LIMITS.outputTokens);
    this.thinking=options.thinking??false;
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new ProviderError('PERMISSION');
    if(!localOnlyConfirmed)throw new ProviderError('PERMISSION');this.base=url.origin;
  }
  async listModels(signal:AbortSignal=AbortSignal.timeout(10000)):Promise<string[]> {
    const result=envelope(TagsSchema,await this.json(`${this.base}/api/tags`,{method:'GET'},signal));
    return result.models.filter(m=>m.size>0&&m.digest.length>=32&&!m.remote_host&&!m.remote_model&&!/(?:^|[-:/])cloud(?:$|[-:/])/i.test(m.name)).map(m=>m.name);
  }
  protected async beforeRequest(model:string,signal:AbortSignal):Promise<void> {
    if(!this.localOnlyConfirmed||!(await this.listModels(signal)).some(name=>name===model||name===`${model}:latest`))throw new ProviderError('MODEL_UNAVAILABLE');
    if(this.thinkingModels.has(model))return;
    // Asked once per model, because `think` may only be sent to a model that supports it.
    try{
      const shown=envelope(ShowSchema,await this.json(`${this.base}/api/show`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model})},signal));
      this.thinkingModels.set(model,(shown.capabilities??[]).includes('thinking'));
    }catch{this.thinkingModels.set(model,false);}
  }
  protected request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean){return {
    url:`${this.base}/api/chat`,headers:{},body:{
      model:args.model,stream:false,
      messages:[{role:'system',content:repairSystem(args.system,repair)},{role:'user',content:args.input}],
      format:schema,
      // Reasoning tokens are drawn from the same bounded output budget as the answer, so a
      // thinking model can exhaust the budget before emitting any JSON and fail a review that
      // it would otherwise complete. Schema-constrained review output does not need them.
      ...(this.thinkingModels.get(args.model)===true?{think:this.thinking}:{}),
      options:{temperature:0,num_ctx:this.contextTokens,num_predict:args.maxOutputTokens??LIMITS.outputTokens},
    },
  };}
  protected decode(raw:unknown):Decoded {
    const value=envelope(ResponseSchema,raw);if(!value.done||value.done_reason==='length')throw new ProviderError('CONTEXT_LIMIT');
    return {text:value.message.content,model:value.model,usage:{...(value.prompt_eval_count!==undefined?{inputTokens:value.prompt_eval_count}:{}),...(value.eval_count!==undefined?{outputTokens:value.eval_count}:{})}};
  }
  async embed(args:EmbedRequest):Promise<EmbedResult> {
    const signal=args.signal?AbortSignal.any([args.signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000);
    await this.beforeRequest(args.model,signal);
    const result=envelope(z.object({embeddings:z.array(z.array(z.number().finite()))}),await this.json(`${this.base}/api/embed`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:args.model,input:args.input,truncate:false})},signal));
    const dimensions=result.embeddings[0]?.length??0;
    if(!dimensions||result.embeddings.length!==args.input.length||result.embeddings.some(v=>v.length!==dimensions))throw new ProviderError('INVALID_OUTPUT');
    return {vectors:result.embeddings,dimensions,provider:this.id,model:args.model};
  }
}
