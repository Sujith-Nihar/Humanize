import { planPublication } from '@humanize/review';
import { ReviewPublisher,StaleHeadError,buildCheck,buildReview } from '@humanize/github';
import type { GitHubTransport,PublishOutcome } from '@humanize/github';
import type { ContentNode,DiffMap,ReviewSnapshot,RunnerResult,ValidatedFinding } from '@humanize/domain';

export interface PublishPorts {
  /** A transport authorised for this installation; the control plane alone holds write access. */
  transport(snapshot:ReviewSnapshot):Promise<GitHubTransport>;
  diff(snapshot:ReviewSnapshot):Promise<DiffMap>;
}
export interface PublishRequest { snapshot:ReviewSnapshot; result:RunnerResult; maxSubjectiveInline?:number; }

/**
 * Rebuilds findings from an accepted runner result. The runner is untrusted, so a candidate is
 * reconstructed only from content the control plane received and re-checked: the quotation must
 * still be present in the node it names, and the node must belong to the reviewed commit.
 */
export function findingsFromResult(result:RunnerResult,snapshot:ReviewSnapshot):ValidatedFinding[] {
  const nodes=new Map<string,ContentNode>(result.nodes.map(node=>[node.id,node]));
  const evidence=new Map(result.evidence.map(record=>[record.id,record]));
  const findings:ValidatedFinding[]=[];
  for(const candidate of result.candidates){
    const node=nodes.get(candidate.nodeId);
    if(!node||node.commitSha!==snapshot.headSha||!node.text.includes(candidate.exactText))continue;
    findings.push({
      ...candidate,node,
      fingerprint:`${node.stableKey}:${candidate.category}:${candidate.exactText}`,
      evidenceRecords:candidate.evidence.map(reference=>evidence.get(reference.id)).filter((record):record is NonNullable<typeof record>=>record!==undefined),
      deterministic:false,blocking:false,verificationConfidence:candidate.confidence,
    });
  }
  return findings;
}

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
