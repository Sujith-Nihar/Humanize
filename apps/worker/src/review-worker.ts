import { ReviewSnapshotSchema } from '@humanize/domain';
import type { JobPayload, ReviewSnapshot } from '@humanize/domain';

/** Creates the lease row a runner can claim for this run. */
export interface RunnerQueue {
  enqueue(organizationId: string, repositoryId: string, runId: string): Promise<void>;
}
export interface ReviewRunRecord {
  organizationId: string; repositoryId: string; runId: string;
  state: string; attempt: number; snapshot: ReviewSnapshot;
}
/** Queues a run for execution in the cloud worker rather than on a customer's runner. */
export interface CloudQueue {
  enqueue(record: ReviewRunRecord): Promise<void>;
}
export interface DispatchPorts {
  /** Resolves the run this job names, scoped to its organization. */
  run(organizationId: string, runId: string): Promise<ReviewRunRecord | null>;
  runners: RunnerQueue;
  cloud?: CloudQueue;
  /** Moves the run to QUEUED once execution has somewhere to happen. */
  queued(record: ReviewRunRecord): Promise<void>;
}
export type DispatchOutcome =
  | { status: 'leased'; runId: string }
  | { status: 'cloud'; runId: string }
  | { status: 'skipped'; reason: 'no_run_id' | 'unknown_run' | 'already_dispatched' | 'terminal_run' | 'cloud_execution_unavailable' | 'no_cloud_credential' };

const TERMINAL = new Set(['STALE', 'CANCELLED', 'COMPLETE', 'FAILED_FINAL']);

/**
 * Turns a scheduled review into work a runner can claim.
 *
 * This is the seam between the control plane deciding that a pull request deserves review and
 * an executor actually doing it. A run goes to a customer's runner or to the cloud worker
 * according to the execution mode its policy fixed, and never to the other one: rerouting a
 * private review to a cloud model would send content somewhere the customer did not choose,
 * which INV-007 forbids. A cloud run with no credential configured is refused for the same
 * reason — falling back to a local model would be just as unasked-for.
 *
 * Creating the lease is idempotent: the queue redelivers, and a duplicate must not hand the
 * same review to two runners.
 */
export async function dispatchReview(payload: JobPayload, ports: DispatchPorts): Promise<DispatchOutcome> {
  if (payload.runId === undefined) return { status: 'skipped', reason: 'no_run_id' };
  const record = await ports.run(payload.organizationId, payload.runId);
  if (!record) return { status: 'skipped', reason: 'unknown_run' };
  // A run that has already moved on is not re-dispatched by a redelivered job.
  if (TERMINAL.has(record.state)) return { status: 'skipped', reason: 'terminal_run' };

  const snapshot = ReviewSnapshotSchema.parse(record.snapshot);

  if (snapshot.executionMode === 'cloud') {
    if (!ports.cloud) return { status: 'skipped', reason: 'cloud_execution_unavailable' };
    // A hosted provider needs a credential. Refusing is the honest outcome: the alternative
    // is reviewing with something the administrator did not select.
    const needsCredential = snapshot.reviewer.provider !== 'ollama' || snapshot.verifier.provider !== 'ollama';
    if (needsCredential && (!snapshot.reviewer.credentialRef || !snapshot.verifier.credentialRef)) {
      return { status: 'skipped', reason: 'no_cloud_credential' };
    }
    if (record.state !== 'RECEIVED') return { status: 'skipped', reason: 'already_dispatched' };
    await ports.cloud.enqueue(record);
    await ports.queued(record);
    return { status: 'cloud', runId: record.runId };
  }

  await ports.runners.enqueue(record.organizationId, record.repositoryId, record.runId);
  // Only the first dispatch advances the state; a redelivery finds it already QUEUED.
  if (record.state === 'RECEIVED') await ports.queued(record);
  else return { status: 'skipped', reason: 'already_dispatched' };
  return { status: 'leased', runId: record.runId };
}
