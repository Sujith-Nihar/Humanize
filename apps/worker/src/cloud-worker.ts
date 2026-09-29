import { validateRunnerResult } from '@humanize/domain';
import type { JobPayload,ModelProvider,ReviewResult,ReviewSnapshot } from '@humanize/domain';
import { ReviewSnapshotSchema } from '@humanize/domain';
import type { ExecutionConfig,ExecutionReport } from '@humanize/execution';
import type { ReviewRunRecord } from './review-worker.js';

/** One of the two model profiles a snapshot fixes, as policy chose them. */
type Profile=ReviewSnapshot['reviewer'];

export interface CloudPorts {
  run(organizationId:string,runId:string):Promise<ReviewRunRecord|null>;
  /** Decrypts a stored provider credential, refusing an unknown, revoked or foreign one. */
  credential(organizationId:string,provider:Profile['provider'],reference:string):Promise<string>;
  /** Builds the adapter for exactly the provider the profile names; never a substitute. */
  provider(profile:Profile,secret:string|null):ModelProvider;
  /** A read-only, single-repository GitHub token for the clone. */
  token(snapshot:ReviewSnapshot):Promise<string>;
  execute(snapshot:ReviewSnapshot,runId:string,ports:{reviewer:ModelProvider;verifier:ModelProvider;token:string},config:ExecutionConfig,signal?:AbortSignal):Promise<ExecutionReport>;
  /** Holds the result for publication and queues the publish job; only the control plane publishes. */
  schedulePublication(snapshot:ReviewSnapshot,result:ReviewResult):Promise<void>;
  config:ExecutionConfig;
}

export type CloudOutcome=
  |{status:'executed';runId:string;candidates:number;inspectedFiles:number;changedNodes:number}
  |{status:'skipped';reason:'no_run_id'|'unknown_run'|'terminal_run'|'not_a_cloud_run'|'no_credential'|'invalid_result'}
  |{status:'retry';errorClass:string};

const TERMINAL=new Set(['COMPLETE','STALE','CANCELLED','FAILED_FINAL']);

/**
 * Resolves the credential a profile names. A hosted provider with no reference configured is
 * refused rather than run unauthenticated or on some other provider: the administrator chose
 * this one, and quietly reviewing the customer's content with a different model would be the
 * cross-provider fallback INV-007 forbids. A local provider legitimately needs no credential.
 */
async function secretFor(organizationId:string,profile:Profile,ports:CloudPorts):Promise<string|null> {
  if(profile.provider==='ollama')return null;
  if(!profile.credentialRef)throw Error('NO_CREDENTIAL');
  return ports.credential(organizationId,profile.provider,profile.credentialRef);
}

/**
 * Executes one cloud review and hands the result to publication.
 *
 * This is the control plane reviewing content itself, which it may do only for an
 * organisation whose policy fixed cloud execution. Work marked for private execution is
 * refused outright: a runner exists so that content never leaves the customer's hardware, and
 * running it here because a queue message arrived would defeat exactly that (INV-007).
 *
 * Nothing about the repository is retained. The clone is ephemeral, and the result is held
 * only until publication completes or is abandoned (ADR-038).
 */
export async function executeCloudReview(payload:JobPayload,ports:CloudPorts,signal?:AbortSignal):Promise<CloudOutcome> {
  const runId=payload.runId;
  if(runId===undefined)return {status:'skipped',reason:'no_run_id'};
  const record=await ports.run(payload.organizationId,runId);
  if(!record)return {status:'skipped',reason:'unknown_run'};
  if(TERMINAL.has(record.state))return {status:'skipped',reason:'terminal_run'};

  const snapshot=ReviewSnapshotSchema.parse(record.snapshot);
  if(snapshot.executionMode!=='cloud')return {status:'skipped',reason:'not_a_cloud_run'};

  let reviewer:ModelProvider,verifier:ModelProvider;
  try{
    // Resolved separately, because policy may name a different credential for each profile
    // and neither may borrow the other's.
    reviewer=ports.provider(snapshot.reviewer,await secretFor(payload.organizationId,snapshot.reviewer,ports));
    verifier=ports.provider(snapshot.verifier,await secretFor(payload.organizationId,snapshot.verifier,ports));
  }catch{
    // A missing, revoked or undecryptable credential ends the run. It is not retried with
    // anything else, and the reason is named rather than surfacing as a generic failure.
    return {status:'skipped',reason:'no_credential'};
  }

  let report:ExecutionReport;
  try{
    // The reviewer and verifier may be different providers, so the pipeline is handed both.
    report=await ports.execute(snapshot,runId,{reviewer,verifier,token:await ports.token(snapshot)},ports.config,signal);
  }catch(error){
    // The queue retries; the workspace is already gone, since the executor destroys it on
    // every exit path.
    return {status:'retry',errorClass:error instanceof Error?error.message.slice(0,100):'UNKNOWN'};
  }

  // The control plane validates its own output too. The executor is trusted code, but the
  // model behind it is not, and an envelope that fails these checks must never be published.
  const violations=validateRunnerResult(report.result,snapshot);
  if(violations.length)return {status:'skipped',reason:'invalid_result'};

  await ports.schedulePublication(snapshot,report.result);
  return {status:'executed',runId,candidates:report.result.candidates.length,
    inspectedFiles:report.inspectedFiles,changedNodes:report.changedNodes};
}
