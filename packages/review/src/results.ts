import type { ContentNode,ReviewResult,ReviewSnapshot,ValidatedFinding } from '@humanize/domain';
import { deterministicFindings } from './deterministic.js';
import type { NodeSignal } from './pipeline.js';

/**
 * Rebuilds publishable findings from an accepted result, whichever executor produced it.
 *
 * The envelope was already validated on upload, but the executor stays untrusted: a candidate is
 * reconstructed only from material the control plane received, and its quotation must still be
 * present in the node it names and that node must belong to the reviewed commit. Anything that
 * fails is dropped rather than published.
 *
 * Deterministic and blocking findings are not taken from the result at all. They are recomputed
 * here from the reviewed nodes with `rules`, which applies the settings the snapshot fixed. A
 * result has no way to say a finding is blocking, so a compromised runner cannot fail a
 * customer's check run, and one that leaves a rule finding out cannot suppress it either (ADR-043).
 * `rules` is required, so no caller can quietly publish without the customer's rules applied.
 */
export function findingsFromResult(result:ReviewResult,snapshot:ReviewSnapshot,rules:(node:ContentNode)=>readonly NodeSignal[]):ValidatedFinding[] {
  const nodes=new Map<string,ContentNode>(result.nodes.map(node=>[node.id,node]));
  const evidence=new Map(result.evidence.map(record=>[record.id,record]));
  const byNode=new Map<string,ValidatedFinding[]>();
  const add=(finding:ValidatedFinding)=>byNode.set(finding.node.id,[...(byNode.get(finding.node.id)??[]),finding]);
  const recomputed=new Set<string>();
  for(const node of result.nodes){
    if(node.commitSha!==snapshot.headSha||node.repositoryId!==snapshot.repositoryId)continue;
    for(const finding of deterministicFindings(node,rules(node))){
      add(finding);
      recomputed.add(`${node.id}\u0000${finding.category}\u0000${finding.exactText}`);
    }
  }
  for(const candidate of result.candidates){
    const node=nodes.get(candidate.nodeId);
    if(!node||node.commitSha!==snapshot.headSha||!node.text.includes(candidate.exactText))continue;
    // The executor reports its rule findings as candidates too; the recomputed one stands.
    if(recomputed.has(`${node.id}\u0000${candidate.category}\u0000${candidate.exactText}`))continue;
    add({
      ...candidate,node,
      fingerprint:`${node.stableKey}:${candidate.category}:${candidate.exactText}`,
      evidenceRecords:candidate.evidence
        .map(reference=>evidence.get(reference.id))
        .filter((record):record is NonNullable<typeof record>=>record!==undefined),
      deterministic:false,blocking:false,verificationConfidence:candidate.confidence,
    });
  }
  // Node order, deterministic first within a node, as the pipeline itself orders them.
  return result.nodes.flatMap(node=>byNode.get(node.id)??[]);
}
