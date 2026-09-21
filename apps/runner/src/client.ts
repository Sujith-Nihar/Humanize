import { ReviewSnapshotSchema,RunnerCapabilitiesSchema,RunnerResultSchema,z } from '@humanize/domain';
import type { RunnerCapabilities,ReviewSnapshot,RunnerResult } from '@humanize/domain';

export class LeaseLostError extends Error { constructor(){super('LEASE_LOST');this.name='LeaseLostError';} }
export class RunnerUnauthorizedError extends Error { constructor(){super('RUNNER_UNAUTHORIZED');this.name='RunnerUnauthorizedError';} }
/** Anything that may succeed on a later attempt: timeouts, partitions and 5xx responses. */
export class TransportError extends Error { constructor(readonly cause:string){super('RUNNER_TRANSPORT_FAILED');this.name='TransportError';} }
/**
 * The control plane refused this request and said why. The code travels with the error because
 * a runner that only knows "4xx" cannot tell an operator whether its result was malformed, too
 * large, or describing content the control plane could not verify.
 */
export class RequestRejectedError extends Error {
  constructor(readonly status:number,readonly code:string,readonly detail:string){
    super(`RUNNER_REQUEST_REJECTED ${status} ${code}${detail?` ${detail}`:''}`);
    this.name='RequestRejectedError';
  }
}

const Remaining=z.number().int().nonnegative().max(24*60*60*1000);
const LeaseResponse=z.object({leaseId:z.string().uuid(),fence:z.number().int().positive(),runId:z.string().uuid(),expiresAt:z.string().min(1),expiresInMs:Remaining,snapshot:ReviewSnapshotSchema}).strict();
const RenewalResponse=z.object({expiresAt:z.string().min(1),expiresInMs:Remaining}).strict();
const RegistrationResponse=z.object({runnerId:z.string().min(1),credential:z.string().min(32)}).strict();
const AcceptedResponse=z.object({accepted:z.literal(true),duplicate:z.boolean()}).strict();
const TokenResponse=z.object({token:z.string().min(1),expiresAt:z.string().min(1),repository:z.object({owner:z.string(),name:z.string()}).strict(),headSha:z.string().min(1),runId:z.string().uuid()}).strict();
export type Lease=z.infer<typeof LeaseResponse>;
export type LeaseCredential=z.infer<typeof TokenResponse>;

export interface RunnerClientOptions { controlPlaneUrl:string; credential?:string; timeoutMs?:number; fetch?:typeof globalThis.fetch; }

/**
 * Outbound half of the lease protocol. Every connection is initiated by the runner, every
 * response is schema validated before use, and the runner credential is never logged or
 * returned. A cancelled, revoked, superseded or expired lease surfaces as LeaseLostError
 * so callers can stop work; anything retryable surfaces as TransportError.
 */
export class RunnerClient {
  private readonly base:URL;
  private readonly timeoutMs:number;
  private readonly send:typeof globalThis.fetch;
  private credential:string|undefined;
  constructor(options:RunnerClientOptions){
    this.base=new URL(options.controlPlaneUrl);
    if(!['http:','https:'].includes(this.base.protocol))throw Error('INVALID_CONTROL_PLANE_URL');
    this.timeoutMs=options.timeoutMs??15000;
    this.send=options.fetch??globalThis.fetch;
    this.credential=options.credential;
  }

  private async call<T>(path:string,body:unknown,schema:z.ZodType<T>|null,options:{authenticated:boolean}):Promise<T|null>{
    const headers:Record<string,string>={'content-type':'application/json'};
    if(options.authenticated){
      if(!this.credential)throw new RunnerUnauthorizedError();
      headers.authorization=`Bearer ${this.credential}`;
    }
    let response:Response;
    try{response=await this.send(new URL(path,this.base),{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});}
    catch(error){throw new TransportError(error instanceof Error?error.name:'unknown');}
    if(response.status===401||response.status===403)throw new RunnerUnauthorizedError();
    if(response.status===409)throw new LeaseLostError();
    if(response.status===204)return null;
    if(response.status>=500)throw new TransportError(`status_${response.status}`);
    if(response.status>=400){
      // Codes only: the control plane never echoes the payload, so nothing here can leak content.
      let code='UNKNOWN',detail='';
      try{
        const body=await response.json() as {error?:unknown;violations?:unknown};
        if(typeof body.error==='string')code=body.error;
        if(Array.isArray(body.violations))detail=body.violations.filter(v=>typeof v==='string').join(',');
      }catch{/* a body that is not JSON tells us nothing extra */}
      throw new RequestRejectedError(response.status,code,detail);
    }
    if(!schema)return null;
    let payload:unknown;
    try{payload=await response.json();}catch{throw new TransportError('invalid_json');}
    // An unexpected control-plane payload is a protocol violation, never coerced into use.
    return schema.parse(payload);
  }

  async register(enrollmentToken:string,capabilities:RunnerCapabilities):Promise<string>{
    const parsed=RunnerCapabilitiesSchema.parse(capabilities);
    const result=await this.call('runner/registrations',{enrollmentToken,capabilities:parsed},RegistrationResponse,{authenticated:false});
    this.credential=result!.credential;return result!.runnerId;
  }
  async heartbeat(capabilities:RunnerCapabilities):Promise<void>{
    await this.call('runner/heartbeats',RunnerCapabilitiesSchema.parse(capabilities),null,{authenticated:true});
  }
  /** Returns null when the control plane has no work for this runner. */
  async claim():Promise<Lease|null>{
    return this.call('runner/leases',{},LeaseResponse,{authenticated:true});
  }
  /** Returns how long the lease remains valid, measured by the control plane, not by clocks. */
  async renew(leaseId:string,fence:number):Promise<number>{
    return (await this.call(`runner/leases/${leaseId}/renewal`,{fence},RenewalResponse,{authenticated:true}))!.expiresInMs;
  }
  async fail(leaseId:string,fence:number,retryable:boolean):Promise<void>{
    await this.call(`runner/leases/${leaseId}/failure`,{fence,retryable},null,{authenticated:true});
  }
  /** Hands the finished review to the control plane, which alone decides what is published. */
  async uploadResult(result:RunnerResult):Promise<{duplicate:boolean}>{
    const validated=RunnerResultSchema.parse(result);
    const accepted=await this.call(`runner/leases/${validated.leaseId}/result`,validated,AcceptedResponse,{authenticated:true});
    return {duplicate:accepted!.duplicate};
  }
  async leaseToken(leaseId:string,fence:number):Promise<LeaseCredential>{
    return (await this.call(`runner/leases/${leaseId}/token`,{fence},TokenResponse,{authenticated:true}))!;
  }
}

export type { ReviewSnapshot };
