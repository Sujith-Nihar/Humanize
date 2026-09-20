import { z } from 'zod';
import type { ModelRequest } from '@humanize/domain';
import { JsonProvider,envelope,repairSystem } from './base.js';
import type { AdapterOptions,Decoded } from './base.js';
import { ProviderError } from './errors.js';

const ResponseSchema=z.object({id:z.string().optional(),model:z.string().optional(),status:z.string(),output:z.array(z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional()})),usage:z.object({input_tokens:z.number().optional(),output_tokens:z.number().optional()}).optional()});
export class OpenAIProvider extends JsonProvider {
  readonly id='openai' as const;
  constructor(private readonly key:string,options:AdapterOptions={}){super(options);if(!key)throw new ProviderError('AUTH');}
  protected request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean){return {
    url:'https://api.openai.com/v1/responses',headers:{authorization:`Bearer ${this.key}`},body:{model:args.model,store:false,input:[{role:'system',content:repairSystem(args.system,repair)},{role:'user',content:args.input}],text:{format:{type:'json_schema',name:'humanize',strict:true,schema}},max_output_tokens:args.maxOutputTokens??4000},
  };}
  protected decode(raw:unknown):Decoded {
    const value=envelope(ResponseSchema,raw);const content=value.output.flatMap(item=>item.content??[]);
    if(content.some(item=>item.type==='refusal'))throw new ProviderError('REFUSAL');
    if(value.status!=='completed')throw new ProviderError('CONTEXT_LIMIT');
    const text=content.filter(item=>item.type==='output_text').map(item=>item.text??'').join('');
    return {text,...(value.id?{requestId:value.id}:{}),...(value.model?{model:value.model}:{}),...(value.usage?{usage:{...(value.usage.input_tokens!==undefined?{inputTokens:value.usage.input_tokens}:{}),...(value.usage.output_tokens!==undefined?{outputTokens:value.usage.output_tokens}:{})}}:{})};
  }
}
