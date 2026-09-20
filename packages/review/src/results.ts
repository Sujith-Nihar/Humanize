import type { ContentNode,ReviewSnapshot,RunnerResult,ValidatedFinding } from '@humanize/domain';

/**
 * Rebuilds publishable findings from an accepted runner result.
 *
 * The envelope was already validated on upload, but the runner stays untrusted: a candidate is
 * reconstructed only from material the control plane received, and its quotation must still be
 * present in the node it names and that node must belong to the reviewed commit. Anything that
 * fails is dropped rather than published.
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
      evidenceRecords:candidate.evidence
        .map(reference=>evidence.get(reference.id))
        .filter((record):record is NonNullable<typeof record>=>record!==undefined),
      deterministic:false,blocking:false,verificationConfidence:candidate.confidence,
    });
  }
  return findings;
}
