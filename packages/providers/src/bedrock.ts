import { z } from 'zod';
import type { ModelRequest } from '@humanize/domain';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
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
 * Amazon Bedrock through the Converse API (ADR-041). Two authentications are supported because
 * AWS offers two: a Bedrock API key sent as a bearer token, and ordinary AWS credentials signed
 * with SigV4. Signing is preferred where credentials exist, since a role or SSO session is
 * short-lived while an API key is a long-lived secret that has to be stored somewhere.
 *
 * The endpoint is fixed to bedrock-runtime in one administrator-chosen region, so neither
 * repository content nor a model identifier can redirect a request elsewhere.
 */
export class BedrockProvider extends JsonProvider {
  readonly id='bedrock' as const;
  private readonly endpoint:string;
  private readonly host:string;
  private readonly region:string;
  private readonly credentials:AwsCredentialIdentityProvider|undefined;

  constructor(key:string|null,region:string,options:AdapterOptions&{credentials?:AwsCredentialIdentityProvider}={}){
    super(options);
    if(!REGION.test(region))throw new ProviderError('PERMISSION');
    // One or the other, never neither: an unauthenticated Bedrock call is a configuration fault.
    if(!key&&!options.credentials)throw new ProviderError('AUTH');
    this.key=key;
    this.credentials=options.credentials;
    this.region=region;
    this.host=`bedrock-runtime.${region}.amazonaws.com`;
    this.endpoint=`https://${this.host}`;
  }
  private readonly key:string|null;

  /**
   * Signs with SigV4 when credentials are configured. The signature covers the exact body that
   * will be sent, so signing happens here rather than in `request`, which cannot see it.
   */
  protected override async json(url:string,init:RequestInit,signal:AbortSignal):Promise<unknown> {
    if(!this.credentials)return super.json(url,init,signal);
    const target=new URL(url);
    const signer=new SignatureV4({service:'bedrock',region:this.region,credentials:this.credentials,sha256:Sha256});
    const signed=await signer.sign(new HttpRequest({
      method:'POST',protocol:target.protocol,hostname:target.hostname,path:target.pathname,
      // `host` must be present and must match what is dialled, or the signature is rejected.
      headers:{host:target.hostname,'content-type':'application/json'},
      body:typeof init.body==='string'?init.body:undefined,
    }));
    return super.json(url,{...init,headers:signed.headers},signal);
  }
  protected request<T>(args:ModelRequest<T>,schema:Record<string,unknown>,repair:boolean){return {
    url:`${this.endpoint}/model/${encodeURIComponent(args.model)}/converse`,
    // A signed request gets its authorization from the signer instead.
    headers:this.key?{authorization:`Bearer ${this.key}`}:{},
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
