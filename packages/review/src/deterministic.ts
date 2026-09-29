import type { ContentNode,ValidatedFinding } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';
import type { NodeSignal } from './pipeline.js';

/**
 * The findings a node's rule signals produce without any model: a blocking violation is a
 * customer policy, and a standalone signal is an objectively countable observation (ADR-037).
 *
 * Deterministic by construction, so the executor and the control plane derive the same findings
 * from the same text and settings. That is what lets publication recompute them rather than trust
 * a runner's word that a finding is blocking (ADR-043).
 */
export function deterministicFindings(node:ContentNode,signals:readonly NodeSignal[]):ValidatedFinding[] {
  return signals.filter(entry=>entry.blocking||entry.standalone===true).map(signal=>({
    nodeId:node.id,category:signal.category,severity:signal.severity,confidence:1,
    exactText:signal.matchedText,explanation:signal.description,
    evidence:[{id:signal.evidence.id,quote:signal.matchedText}],
    // A rule offers a replacement only where deleting the construction is unambiguous;
    // the control plane still proves it is a safe patch before publishing it.
    replacement:signal.replacement??null,requiresVerification:false,
    fingerprint:fingerprint(['finding',node.stableKey,signal.ruleId,signal.matchedText]),
    node,evidenceRecords:[signal.evidence],deterministic:true,blocking:signal.blocking,verificationConfidence:1,
  }));
}
