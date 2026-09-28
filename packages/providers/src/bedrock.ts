import { z } from 'zod';
import type { ModelRequest } from '@humanize/domain';
import { JsonProvider,envelope,repairSystem } from './base.js';
import type { AdapterOptions,Decoded } from './base.js';
import { ProviderError } from './errors.js';

const ResponseSchema=z.object({
  output:z.object({message:z.object({content:z.array(z.object({text:z.string().optional()}).passthrough())}).optional()}),
  stopReason:z.string(),
  usage:z.object({inputTokens:z.number().optional(),outputTokens:z.number().optional()}).optional(),
});

/**
 * Bedrock structured output accepts a subset of JSON Schema and rejects the whole request with a
 * 400 when a schema uses length, numeric or item-count constraints. Those keywords are removed
 * from what is sent only: the base adapter still validates every response against the full Zod
 * schema, so a model that exceeds a limit Bedrock was not told about is refused locally.
 */
const UNSUPPORTED_KEYWORDS=new Set(['minLength','maxLength','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','maxItems','pattern','format']);
export function bedrockSchema(value:unknown):unknown {
  if(Array.isArray(value))return value.map(bedrockSchema);
  if(value===null||typeof value!=='object')return value;
  const result:Record<string,unknown>={};
  for(const [key,entry] of Object.entries(value)){
    if(UNSUPPORTED_KEYWORDS.has(key))continue;
    // Only 0 and 1 are accepted for minItems.
    if(key==='minItems'&&typeof entry==='number'&&entry>1){result[key]=1;continue;}
    result[key]=bedrockSchema(entry);
  }
  return result;
}

/** Commercial and GovCloud region names; anything else never reaches a URL. */
const REGION=/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

/**
 * Amazon Bedrock through the Converse API, authenticated with a Bedrock API key as a bearer
 * token (ADR-041). The endpoint is fixed to bedrock-runtime in one administrator-chosen region,
 * so neither repository content nor a model identifier can redirect a request elsewhere.
 */
export class BedrockProvider extends JsonProvider {
  readonly id='bedrock' as const;
  private readonly endpoint:string;
  constructor(private readonly key:string,region:string,options:AdapterOptions={}){
    super(options);
    if(!key)throw new ProviderError('AUTH');
    if(!REGION.test(region))throw new ProviderError('PERMISSION');
    this.endpoint=`https://bedrock-runtime.${region}.amazonaws.com`;
  }
  protected request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean){return {
    url:`${this.endpoint}/model/${encodeURIComponent(args.model)}/converse`,headers:{authorization:`Bearer ${this.key}`},
    body:{
      system:[{text:repairSystem(args.system,repair)}],
      messages:[{role:'user',content:[{text:args.input}]}],
      inferenceConfig:{maxTokens:args.maxOutputTokens??4000},
      outputConfig:{textFormat:{type:'json_schema',structure:{jsonSchema:{name:'humanize',schema:JSON.stringify(bedrockSchema(schema))}}}},
    },
  };}
  protected decode(raw:unknown):Decoded {
    const value=envelope(ResponseSchema,raw);
    if(['guardrail_intervened','content_filtered'].includes(value.stopReason))throw new ProviderError('REFUSAL');
    if(['max_tokens','model_context_window_exceeded'].includes(value.stopReason))throw new ProviderError('CONTEXT_LIMIT');
    const text=(value.output.message?.content??[]).map(block=>block.text??'').join('');
    if(value.stopReason!=='end_turn'||!text)throw new ProviderError('INVALID_OUTPUT');
    return {text,...(value.usage?{usage:{...(value.usage.inputTokens!==undefined?{inputTokens:value.usage.inputTokens}:{}),...(value.usage.outputTokens!==undefined?{outputTokens:value.usage.outputTokens}:{})}}:{})};
  }
}
