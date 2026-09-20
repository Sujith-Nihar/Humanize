import { z } from 'zod';
import type { ModelRequest } from '@humanize/domain';
import { JsonProvider,envelope,repairSystem } from './base.js';
import type { AdapterOptions,Decoded } from './base.js';
import { ProviderError } from './errors.js';
const ResponseSchema=z.object({responseId:z.string().optional(),modelVersion:z.string().optional(),promptFeedback:z.object({blockReason:z.string().optional()}).optional(),candidates:z.array(z.object({finishReason:z.string().optional(),content:z.object({parts:z.array(z.object({text:z.string().optional(),thought:z.boolean().optional()}))}).optional()})).optional(),usageMetadata:z.object({promptTokenCount:z.number().optional(),candidatesTokenCount:z.number().optional()}).optional()});
export class GeminiProvider extends JsonProvider {
  readonly id='gemini' as const;
  constructor(private readonly key:string,options:AdapterOptions={}){super(options);if(!key)throw new ProviderError('AUTH');}
  protected request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean){return {
    url:`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model.replace(/^models\//,''))}:generateContent`,headers:{'x-goog-api-key':this.key},body:{systemInstruction:{parts:[{text:repairSystem(args.system,repair)}]},contents:[{role:'user',parts:[{text:args.input}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema,maxOutputTokens:args.maxOutputTokens??4000}},
  };}
  protected decode(raw:unknown):Decoded {
    const value=envelope(ResponseSchema,raw);const candidate=value.candidates?.[0];
    if(value.promptFeedback?.blockReason||['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(candidate?.finishReason??''))throw new ProviderError('REFUSAL');
    if(candidate?.finishReason==='MAX_TOKENS')throw new ProviderError('CONTEXT_LIMIT');
    if(!candidate?.content||candidate.finishReason!=='STOP')throw new ProviderError('INVALID_OUTPUT');
    return {text:candidate.content.parts.filter(p=>!p.thought).map(p=>p.text??'').join(''),...(value.responseId?{requestId:value.responseId}:{}),...(value.modelVersion?{model:value.modelVersion}:{}),...(value.usageMetadata?{usage:{...(value.usageMetadata.promptTokenCount!==undefined?{inputTokens:value.usageMetadata.promptTokenCount}:{}),...(value.usageMetadata.candidatesTokenCount!==undefined?{outputTokens:value.usageMetadata.candidatesTokenCount}:{})}}:{})};
  }
}
