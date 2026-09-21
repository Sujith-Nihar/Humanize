import { LeaseLostError,RunnerUnauthorizedError,TransportError } from './client.js';
import type { Lease,LeaseCredential,RunnerClient } from './client.js';

/** Receives the lease and a signal that aborts the moment the lease stops being held. */
export type LeaseExecutor<T>=(context:{lease:Lease;credential:LeaseCredential;signal:AbortSignal})=>Promise<T>;
export type LeaseOutcome<T>={status:'completed';value:T}|{status:'lost'}|{status:'failed';retryable:boolean;errorClass:string};

export interface LeaseSessionOptions { renewIntervalMs?:number; safetyMarginMs?:number; now?:()=>number; }

/** Errors carrying `retryable:false` are permanent; anything else is retried within the attempt budget. */
function retryable(error:unknown):boolean {
  const flag=(error as {retryable?:unknown}).retryable;
  return typeof flag==='boolean'?flag:!(error instanceof RunnerUnauthorizedError);
}

/**
 * Owns one lease for the duration of one job: renews on a timer, aborts the executor when
 * the lease is lost to cancellation, revocation, a superseded fence, expiry or a partition
 * that outlasts the lease, and reports a failed attempt with its retry classification.
 *
 * A lost lease never reports a result and never reports a failure: another runner now owns
 * the work, and the fence this session holds is stale. The job-scoped GitHub credential is
 * dropped on every exit path, because an installation token stays valid for up to an hour
 * after the lease that justified it is gone.
 */
export async function runLease<T>(client:RunnerClient,lease:Lease,execute:LeaseExecutor<T>,options:LeaseSessionOptions={},report?:(value:T)=>Promise<void>):Promise<LeaseOutcome<T>> {
  const renewIntervalMs=options.renewIntervalMs??30000;
  const safetyMarginMs=options.safetyMarginMs??5000;
  const now=options.now??(()=>Date.now());
  const controller=new AbortController();
  // The control plane reports how long the lease still has, never an absolute time this
  // process must agree with. Comparing its timestamp against a local clock would make the
  // runner abandon valid work, or keep working past the lease, whenever the two disagree.
  let deadline=now()+lease.expiresInMs;
  let lost=false,timer:ReturnType<typeof setTimeout>|undefined;
  const lose=()=>{lost=true;controller.abort(new LeaseLostError());};

  const schedule=()=>{
    timer=setTimeout(()=>{void tick();},renewIntervalMs);
    timer.unref?.();
  };
  const tick=async()=>{
    if(lost)return;
    try{deadline=now()+await client.renew(lease.leaseId,lease.fence);}
    catch(error){
      // A partition is survivable only while the lease this runner already holds is valid.
      if(error instanceof TransportError&&now()<deadline-safetyMarginMs){schedule();return;}
      lose();return;
    }
    schedule();
  };

  try{
    // The job-scoped credential lives only in this call frame and is handed to the executor
    // for the duration of the session; nothing retains it once the session returns.
    const credential=await client.leaseToken(lease.leaseId,lease.fence);
    schedule();
    const value=await execute({lease,credential,signal:controller.signal});
    // A lost lease belongs to another runner now, so its work is dropped rather than uploaded.
    if(lost)return {status:'lost'};
    if(report){
      await report(value);
      if(lost)return {status:'lost'};
    }
    return {status:'completed',value};
  }catch(error){
    if(lost||error instanceof LeaseLostError)return {status:'lost'};
    const permanent=!retryable(error);
    try{await client.fail(lease.leaseId,lease.fence,!permanent);}
    catch(reportFailure){if(reportFailure instanceof LeaseLostError)return {status:'lost'};}
    return {status:'failed',retryable:!permanent,errorClass:error instanceof Error?error.message.slice(0,200):'UNKNOWN'};
  }finally{
    if(timer)clearTimeout(timer);
    // Aborting on the way out tells anything still holding the signal to drop the credential.
    if(!controller.signal.aborted)controller.abort(new Error('LEASE_SESSION_ENDED'));
  }
}
