import type { PublicationStore } from '@humanize/db';
import type { JobPayload,ReviewSnapshot,RunnerResult } from '@humanize/domain';
import { RunnerResultSchema } from '@humanize/domain';

export interface StoredPublication { snapshot:ReviewSnapshot; result:RunnerResult; }
export type PublishOutcome=
  |{status:'published';reviewId:number|null}
  |{status:'skipped';reason:'no_payload'|'stale_head'|'invalid_payload'}
  |{status:'retry';errorClass:string};

export interface PublishPorts {
  publications:PublicationStore;
  publish(input:StoredPublication):Promise<{reviewId:number|null}|{skipped:'stale_head';current:string}>;
}

/**
 * Publishes one accepted review, then removes the payload that held its content.
 *
 * The payload is discarded on every path that will not publish later, including an abandoned
 * one, because unpublishable content is still content and ephemeral retention promises none
 * survives the job (ADR-038). It is kept only for a failure that a retry could still resolve,
 * since discarding then would lose a review the queue is about to attempt again.
 */
export async function publishReview(payload:JobPayload,ports:PublishPorts):Promise<PublishOutcome> {
  const runId=payload.runId;
  if(runId===undefined)return {status:'skipped',reason:'no_payload'};
  const held=await ports.publications.take(payload.organizationId,runId);
  if(!held)return {status:'skipped',reason:'no_payload'};

  let stored:StoredPublication;
  try{
    const value=held.payload as {snapshot:ReviewSnapshot;result:unknown};
    stored={snapshot:value.snapshot,result:RunnerResultSchema.parse(value.result)};
  }catch{
    // A payload that cannot be parsed will never publish, so it is content with no purpose.
    await ports.publications.discard(payload.organizationId,runId);
    return {status:'skipped',reason:'invalid_payload'};
  }

  try{
    const outcome=await ports.publish(stored);
    await ports.publications.discard(payload.organizationId,runId);
    // A superseded head is an expected end: a newer review supersedes this one.
    return 'skipped' in outcome?{status:'skipped',reason:'stale_head'}:{status:'published',reviewId:outcome.reviewId};
  }catch(error){
    // Kept deliberately: the queue will try again, and discarding now would lose the review.
    return {status:'retry',errorClass:error instanceof Error?error.message.slice(0,100):'UNKNOWN'};
  }
}
