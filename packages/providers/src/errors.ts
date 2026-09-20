export type ProviderErrorCode='AUTH'|'PERMISSION'|'MODEL_UNAVAILABLE'|'UNSUPPORTED_CAPABILITY'|'RATE_LIMIT'|'TIMEOUT'|'TRANSPORT'|'REFUSAL'|'CONTEXT_LIMIT'|'INVALID_OUTPUT'|'CANCELLED';
export class ProviderError extends Error {
  constructor(readonly code:ProviderErrorCode,readonly retryable=false,readonly retryAfterMs?:number){super(code);this.name='ProviderError';}
}
export function httpError(status:number,retryAfter:string|null):ProviderError {
  const seconds=retryAfter===null?NaN:Number(retryAfter);
  const retryMs=Number.isFinite(seconds)?Math.max(0,seconds*1000):retryAfter?Math.max(0,Date.parse(retryAfter)-Date.now()):undefined;
  if(status===401)return new ProviderError('AUTH');
  if(status===403)return new ProviderError('PERMISSION');
  if(status===404)return new ProviderError('MODEL_UNAVAILABLE');
  if(status===429)return new ProviderError('RATE_LIMIT',true,retryMs);
  if(status===408||status>=500)return new ProviderError('TRANSPORT',true,retryMs);
  if(status===413)return new ProviderError('CONTEXT_LIMIT');
  return new ProviderError('UNSUPPORTED_CAPABILITY');
}
