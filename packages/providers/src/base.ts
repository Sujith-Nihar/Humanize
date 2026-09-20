import { z } from 'zod';
import { ReviewerResponseSchema } from '@humanize/domain';
import type { ModelProvider,ModelRequest,ModelResult,ProviderCapabilities } from '@humanize/domain';
import { sleep } from '@humanize/shared';
import { ProviderError,httpError } from './errors.js';

export interface AdapterOptions { fetch?:typeof fetch; retryDelayMs?:number; contextTokens?:number; thinking?:boolean; }
export interface Decoded {text:string;model?:string;requestId?:string;usage?:{inputTokens?:number;outputTokens?:number};}
export abstract class JsonProvider implements ModelProvider {
  abstract readonly id:ModelProvider['id'];
  protected readonly transport:typeof fetch;
  protected readonly retryDelay:number;
  constructor(options:AdapterOptions={}) {this.transport=options.fetch??fetch;this.retryDelay=options.retryDelayMs??500;}
  protected abstract request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean):{url:string;headers:Record<string,string>;body:unknown};
  protected abstract decode(raw:unknown):Decoded;
  protected async beforeRequest(_model:string,_signal:AbortSignal):Promise<void> {}
  protected async json(url:string,init:RequestInit,signal:AbortSignal):Promise<unknown> {
    const response=await this.transport(url,{...init,redirect:'error',signal});
    if(!response.ok){await response.body?.cancel();throw httpError(response.status,response.headers.get('retry-after'));}
    if(!response.body)throw new ProviderError('INVALID_OUTPUT');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>8*1024*1024)throw new ProviderError('INVALID_OUTPUT');chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ProviderError('INVALID_OUTPUT');}
  }
  async generateStructured<T>(args:ModelRequest<T>):Promise<ModelResult<T>> {
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(args.model))throw new ProviderError('MODEL_UNAVAILABLE');
    if(!Number.isFinite(args.timeoutMs)||args.timeoutMs<=0)throw new ProviderError('TIMEOUT');
    const deadline=AbortSignal.timeout(Math.min(args.timeoutMs,this.id==='ollama'?180000:90000));
    const signal=args.signal?AbortSignal.any([args.signal,deadline]):deadline;
    const start=performance.now();let retries=0,repair=false;
    let schema:Record<string,unknown>;
    try{schema=z.toJSONSchema(args.schema,{target:'draft-7',io:'output'}) as Record<string,unknown>;delete schema.$schema;}catch{throw new ProviderError('UNSUPPORTED_CAPABILITY');}
    for(;;){
      try {
        signal.throwIfAborted();await this.beforeRequest(args.model,signal);
        const req=this.request(args,schema,repair);
        const raw=await this.json(req.url,{method:'POST',headers:{'content-type':'application/json',...req.headers},body:JSON.stringify(req.body)},signal);
        const decoded=this.decode(raw);
        let json:unknown;try{json=JSON.parse(decoded.text);}catch{throw new ProviderError('INVALID_OUTPUT');}
        const result=args.schema.safeParse(json);if(!result.success)throw new ProviderError('INVALID_OUTPUT');
        return {data:result.data,provider:this.id,model:decoded.model??args.model,durationMs:performance.now()-start,...(decoded.requestId?{requestId:decoded.requestId}:{}),...(decoded.usage?{usage:decoded.usage}:{})};
      }catch(error){
        if(args.signal?.aborted)throw new ProviderError('CANCELLED');
        if(deadline.aborted)throw new ProviderError('TIMEOUT',true);
        const normalized=error instanceof ProviderError?error:new ProviderError('TRANSPORT',true);
        if(normalized.code==='INVALID_OUTPUT'&&!repair){repair=true;continue;}
        if(!normalized.retryable||retries>=2)throw normalized;
        const delay=normalized.retryAfterMs??this.retryDelay*2**retries*(0.75+Math.random()/2);retries++;
        try{await sleep(delay,signal);}catch{throw new ProviderError(args.signal?.aborted?'CANCELLED':'TIMEOUT',!args.signal?.aborted);}
      }
    }
  }
  async testConnection(model:string,signal?:AbortSignal):Promise<ProviderCapabilities> {
    const start=performance.now();
    const common={model,timeoutMs:this.id==='ollama'?180000:90000,traceContext:{traceId:'capability-probe'},...(signal?{signal}:{})};
    await this.generateStructured({...common,system:'Return exactly the requested JSON object.',input:'Return {"ok":true}.',schema:z.object({ok:z.literal(true)}).strict()});
    await this.generateStructured({...common,system:'Return the required content-review schema. This is a compatibility test with no repository content.',input:'Return candidates [] and searches [].',schema:ReviewerResponseSchema});
    return {provider:this.id,model,structuredOutput:true,embeddings:false,latencyMs:performance.now()-start,testedAt:new Date().toISOString()};
  }
}

export function envelope<T>(schema:z.ZodType<T>,raw:unknown):T {
  const result=schema.safeParse(raw);if(!result.success)throw new ProviderError('INVALID_OUTPUT');return result.data;
}
export function repairSystem(system:string,repair:boolean):string {return repair?`${system}\nYour previous response did not satisfy the required schema. Return valid JSON matching that schema, without prose or code fences.`:system;}
