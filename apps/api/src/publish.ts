import { findingsFromResult,planPublication } from '@humanize/review';
import { ReviewPublisher,StaleHeadError,buildCheck,buildReview } from '@humanize/github';
import type { GitHubTransport,PublishOutcome } from '@humanize/github';
import type { DiffMap,ReviewSnapshot,RunnerResult } from '@humanize/domain';

export interface PublishPorts {
  /** A transport authorised for this installation; the control plane alone holds write access. */
  transport(snapshot:ReviewSnapshot):Promise<GitHubTransport>;
  diff(snapshot:ReviewSnapshot):Promise<DiffMap>;
}
export interface PublishRequest { snapshot:ReviewSnapshot; result:RunnerResult; maxSubjectiveInline?:number; }

/**
 * Publishes an accepted result. Only the control plane reaches GitHub: the runner holds a
 * read-only, single-repository token and never has permission to comment.
 */
export async function publishResult(request:PublishRequest,ports:PublishPorts):Promise<PublishOutcome|{skipped:'stale_head';current:string}> {
  const findings=findingsFromResult(request.result,request.snapshot);
  const plan=planPublication(findings,{...(request.maxSubjectiveInline!==undefined?{maxSubjectiveInline:request.maxSubjectiveInline}:{})});
  const diff=await ports.diff(request.snapshot);
  const review=buildReview({inline:plan.inline,summary:plan.summary,diff,reviewedNodes:request.result.nodes.length});
  const check=buildCheck([...plan.inline,...plan.summary]);
  try{
    return await new ReviewPublisher(await ports.transport(request.snapshot)).publish(
      {owner:request.snapshot.owner,repo:request.snapshot.repository,pullNumber:request.snapshot.pullNumber,headSha:request.snapshot.headSha},
      review,check,
    );
  }catch(error){
    // A superseded head is an expected outcome, not a failure: a newer review supersedes this one.
    if(error instanceof StaleHeadError)return {skipped:'stale_head',current:error.current};
    throw error;
  }
}
