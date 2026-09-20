import { sleep } from '@humanize/shared';
import { RunnerUnauthorizedError,TransportError } from './client.js';
import type { RunnerClient } from './client.js';
import { runLease } from './lease.js';
import type { LeaseExecutor,LeaseOutcome } from './lease.js';
import type { RunnerCapabilities } from '@humanize/domain';

export interface RunnerLoopOptions {
  capabilities:RunnerCapabilities;
  idleDelayMs?:number;
  backoffMs?:number;
  signal?:AbortSignal;
  onOutcome?:(outcome:LeaseOutcome<unknown>)=>void;
  report?:(value:unknown)=>Promise<void>;
}

/**
 * Claims one job at a time and heartbeats between claims. The loop never widens its own
 * authorization: a revoked credential stops it rather than re-registering, and transport
 * failures back off instead of spinning against an unreachable control plane.
 */
export async function pollForWork<T>(client:RunnerClient,execute:LeaseExecutor<T>,options:RunnerLoopOptions):Promise<void> {
  const idleDelayMs=options.idleDelayMs??5000,backoffMs=options.backoffMs??15000;
  while(!options.signal?.aborted){
    try{
      await client.heartbeat(options.capabilities);
      const lease=await client.claim();
      if(!lease){await sleep(idleDelayMs,options.signal);continue;}
      options.onOutcome?.(await runLease(client,lease,execute,{},options.report));
    }catch(error){
      if(error instanceof RunnerUnauthorizedError)throw error;
      if(!(error instanceof TransportError))throw error;
      await sleep(backoffMs,options.signal);
    }
  }
}
