import type { RunnerResult } from '@humanize/domain';
import { executeReview as execute } from '@humanize/execution';
import type { ExecutionConfig,ExecutionReport as SharedReport } from '@humanize/execution';
import type { ModelProvider } from '@humanize/domain';
import type { Lease,LeaseCredential } from './client.js';

export type ExecutorConfig=ExecutionConfig;
export interface ExecutorPorts { provider:ModelProvider; }
/** The shared report, with the lease-bound envelope a runner uploads. */
export interface ExecutionReport extends Omit<SharedReport,'result'> { result:RunnerResult; }

/**
 * Runs one leased review and binds the result to the lease that authorised it.
 *
 * The review itself is the shared one; what this adds is the two refusals a runner exists
 * for. A runner runs only work marked for private execution, and only against a local model:
 * a cloud profile arriving here would send the customer's content somewhere they chose a
 * runner precisely to avoid, so it is a configuration fault rather than something to work
 * around (INV-007).
 */
export async function executeReview(
  lease:Lease,credential:LeaseCredential,ports:ExecutorPorts,config:ExecutorConfig,signal?:AbortSignal,
):Promise<ExecutionReport> {
  const snapshot=lease.snapshot;
  if(snapshot.executionMode!=='runner')throw Error('NOT_A_RUNNER_JOB');
  if(snapshot.reviewer.provider!=='ollama'||snapshot.verifier.provider!=='ollama')throw Error('CLOUD_MODEL_IN_PRIVATE_JOB');

  const report=await execute(snapshot,lease.runId,{provider:ports.provider,token:credential.token},config,signal);
  // The lease identity is added here rather than inside the review, because it is what proves
  // this upload answers the work that was handed out, and only a leased run has one.
  return {...report,result:{...report.result,leaseId:lease.leaseId,fence:lease.fence}};
}
