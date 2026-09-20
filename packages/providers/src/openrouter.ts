import { z } from 'zod';
import type { ModelRequest } from '@humanize/domain';
import { JsonProvider,envelope,repairSystem } from './base.js';
import type { AdapterOptions,Decoded } from './base.js';
import { ProviderError } from './errors.js';
const ResponseSchema=z.object({id:z.string().optional(),model:z.string().optional(),choices:z.array(z.object({finish_reason:z.string(),message:z.object({content:z.string().nullable(),refusal:z.string().nullable().optional()})})),usage:z.object({prompt_tokens:z.number().optional(),completion_tokens:z.number().optional()}).optional()});
export class OpenRouterProvider extends JsonProvider {
  readonly id='openrouter' as const;
  constructor(private readonly key:string,private readonly upstreamProviders:string[]=[],options:AdapterOptions={}){super(options);if(!key)throw new ProviderError('AUTH');}
  protected request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean){return {
    url:'https://openrouter.ai/api/v1/chat/completions',headers:{authorization:`Bearer ${this.key}`,'X-Title':'Humanize'},body:{model:args.model,messages:[{role:'system',content:repairSystem(args.system,repair)},{role:'user',content:args.input}],response_format:{type:'json_schema',json_schema:{name:'humanize',strict:true,schema}},provider:{require_parameters:true,allow_fallbacks:false,...(this.upstreamProviders.length?{only:this.upstreamProviders}:{})},max_tokens:args.maxOutputTokens??4000},
  };}
  protected decode(raw:unknown):Decoded {
    const value=envelope(ResponseSchema,raw);const choice=value.choices[0];
    if(choice?.message.refusal||choice?.finish_reason==='content_filter')throw new ProviderError('REFUSAL');
    if(choice?.finish_reason==='length')throw new ProviderError('CONTEXT_LIMIT');
    if(!choice?.message.content||choice.finish_reason!=='stop')throw new ProviderError('INVALID_OUTPUT');
    return {text:choice.message.content,...(value.id?{requestId:value.id}:{}),...(value.model?{model:value.model}:{}),...(value.usage?{usage:{...(value.usage.prompt_tokens!==undefined?{inputTokens:value.usage.prompt_tokens}:{}),...(value.usage.completion_tokens!==undefined?{outputTokens:value.usage.completion_tokens}:{})}}:{})};
  }
}
