import { CandidateSchema,ReviewerResponseSchema,VerificationSchema,candidateDigest } from '@humanize/domain';
import type { CandidateFinding,ContentNode,EvidenceRecord,ModelProvider,ReviewSnapshot,ValidatedFinding,z } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';
import { REVIEWER_SYSTEM,VERIFIER_SYSTEM,reviewerInput,verifierInput } from './prompt.js';
import { routeNode } from './router.js';
import type { CategoryName,RoutingOptions } from './router.js';
import { applyVerification,validateCandidate } from './core.js';
import type { ReviewableUnit,SuppressionReason } from './core.js';

export { authorFacing } from './core.js';
export type { SuppressionReason } from './core.js';

export interface SuppressedCandidate { nodeId:string; category:string; reason:SuppressionReason; }
export interface NodeSignal { ruleId:string; description:string; category:CategoryName; severity:'major'|'minor'|'nit'; start:number; end:number; matchedText:string; blocking:boolean; standalone?:boolean; replacement?:string; evidence:EvidenceRecord; }

export interface ReviewPorts {
  reviewer:ModelProvider; reviewerModel:string;
  verifier:ModelProvider; verifierModel:string;
  context(node:ContentNode):Promise<EvidenceRecord[]>;
  rules(node:ContentNode):NodeSignal[];
}
export interface ReviewOptions extends RoutingOptions {
  minimumSeverity?:'major'|'minor'|'nit';
  confidenceThreshold?:number;
  timeoutMs?:number;
  signal?:AbortSignal;
  marker?:string;
}
export interface NodeFailure { nodeId:string; errorClass:string; }
export interface ReviewOutcome { findings:ValidatedFinding[]; suppressed:SuppressedCandidate[]; failures:NodeFailure[]; reviewed:number; diagnostics:{code:string;count:number}[]; }

const SEVERITY_RANK={nit:0,minor:1,major:2} as const;
/** The architecture starts both thresholds at 0.90; these are heuristics, not probabilities. */
export const DEFAULT_CONFIDENCE=0.9;

function boundaryMarker():string {
  // Unguessable per review, so quoted repository text cannot terminate its own fence.
  return `hz-${fingerprint([Math.random(),Date.now()]).slice(0,24)}`;
}

/**
 * Reviews changed content node by node. Deterministic blocking-rule violations become findings
 * without a model. Model-proposed findings are validated, then independently verified by a
 * separate invocation — separate even when reviewer and verifier are the same model, because a
 * single call cannot both propose and impartially check.
 */
export async function reviewNodes(snapshot:ReviewSnapshot,nodes:readonly ContentNode[],ports:ReviewPorts,options:ReviewOptions):Promise<ReviewOutcome> {
  const marker=options.marker??boundaryMarker();
  const threshold=options.confidenceThreshold??DEFAULT_CONFIDENCE;
  const minimum=SEVERITY_RANK[options.minimumSeverity??'minor'];
  const timeoutMs=options.timeoutMs??60000;
  const findings:ValidatedFinding[]=[];
  const suppressed:SuppressedCandidate[]=[];
  const failures:NodeFailure[]=[];
  const diagnosticCounts=new Map<string,number>();
  let reviewed=0;

  for(const node of nodes){
    options.signal?.throwIfAborted();
    if(node.repositoryId!==snapshot.repositoryId||node.commitSha!==snapshot.headSha)throw Error('NODE_OUT_OF_SNAPSHOT');
    const routing=routeNode(node,options);
    const signals=ports.rules(node);
    // Repository-specific preparation ends here: everything downstream that reaches the model
    // or validates its output does so through this minimal, source-agnostic shape.
    const unit:ReviewableUnit={id:node.id,text:node.text,placeholders:node.placeholders};

    // A blocking violation is a customer policy; a standalone signal is an objectively
    // countable observation (ADR-037). Neither needs a model to agree that it is present.
    for(const signal of signals.filter(entry=>entry.blocking||entry.standalone===true)){
      findings.push({
        nodeId:node.id,category:signal.category,severity:signal.severity,confidence:1,
        exactText:signal.matchedText,explanation:signal.description,
        evidence:[{id:signal.evidence.id,quote:signal.matchedText}],
        // A rule offers a replacement only where deleting the construction is unambiguous;
        // the control plane still proves it is a safe patch before publishing it.
        replacement:signal.replacement??null,requiresVerification:false,
        fingerprint:fingerprint(['finding',node.stableKey,signal.ruleId,signal.matchedText]),
        node,evidenceRecords:[signal.evidence],deterministic:true,blocking:signal.blocking,verificationConfidence:1,
      });
    }
    if(!routing.eligible)continue;
    reviewed++;

    try{
    const evidenceRecords=await ports.context(node);
    const evidence=new Map(evidenceRecords.map(record=>[record.id,record]));
    for(const signal of signals)evidence.set(signal.evidence.id,signal.evidence);

    const response=await ports.reviewer.generateStructured({
      model:ports.reviewerModel,system:REVIEWER_SYSTEM,
      input:reviewerInput({unit,contextLabel:`Content kind: ${node.kind}. Source: ${node.filePath}.`,categories:routing.categories,evidence:[...evidence.values()],ruleNotes:signals.map(entry=>entry.description),marker}),
      schema:ReviewerResponseSchema,timeoutMs,traceContext:{traceId:snapshot.configHash},
      ...(options.signal?{signal:options.signal}:{}),
    });

    const accepted:CandidateFinding[]=[];
    for(const raw of response.data.candidates){
      const candidate=CandidateSchema.parse(raw);
      const reason=validateCandidate(candidate,unit,routing.categories,evidence);
      if(reason){suppressed.push({nodeId:node.id,category:candidate.category,reason});continue;}
      if(candidate.confidence<threshold){suppressed.push({nodeId:node.id,category:candidate.category,reason:'below_confidence'});continue;}
      if(SEVERITY_RANK[candidate.severity]<minimum){suppressed.push({nodeId:node.id,category:candidate.category,reason:'below_minimum_severity'});continue;}
      accepted.push(candidate);
    }
    if(!accepted.length)continue;

    // A separate invocation, with its own system prompt and only the surviving candidates.
    const verdicts=await ports.verifier.generateStructured({
      model:ports.verifierModel,system:VERIFIER_SYSTEM,
      input:verifierInput({unit,evidence:[...evidence.values()],marker,
        candidates:accepted.map(candidate=>({id:candidateDigest(candidate),category:candidate.category,severity:candidate.severity,exactText:candidate.exactText,explanation:candidate.explanation}))}),
      schema:VerificationSchema,timeoutMs,traceContext:{traceId:snapshot.configHash},
      ...(options.signal?{signal:options.signal}:{}),
    });
    const byIdentity=new Map(VerificationSchema.parse(verdicts.data).results.map(result=>[result.candidateId,result]));

    for(const candidate of accepted){
      const verdict=byIdentity.get(candidateDigest(candidate));
      // No verdict means unverified, and unverified never publishes.
      if(!verdict){suppressed.push({nodeId:node.id,category:candidate.category,reason:'verifier_missing_verdict'});continue;}
      if(!verdict.publish||verdict.confidence<threshold){suppressed.push({nodeId:node.id,category:candidate.category,reason:'verifier_suppressed'});continue;}
      // A verifier's corrections are model output like any other, so they are revalidated
      // rather than trusted: a correction that drops a placeholder, or that echoes the
      // instructions instead of addressing the author, is discarded and the reviewer's
      // original stands. This check is source-agnostic, so it lives in the common core.
      const applied=applyVerification(candidate,verdict,VERIFIER_SYSTEM);
      if(applied.notAuthorFacing)diagnosticCounts.set('CORRECTION_NOT_AUTHOR_FACING',(diagnosticCounts.get('CORRECTION_NOT_AUTHOR_FACING')??0)+1);
      if(applied.placeholderDropped)diagnosticCounts.set('CORRECTION_DROPPED_PLACEHOLDER',(diagnosticCounts.get('CORRECTION_DROPPED_PLACEHOLDER')??0)+1);
      findings.push({
        ...candidate,explanation:applied.explanation,replacement:applied.replacement,
        fingerprint:fingerprint(['finding',node.stableKey,candidate.category,candidate.exactText]),
        node,evidenceRecords:candidate.evidence.map(reference=>evidence.get(reference.id)!),
        deterministic:false,blocking:false,verificationConfidence:verdict.confidence,
      });
    }
    }catch(error){
      // One node that a model mishandles must not discard the findings for every other node:
      // a review of twenty changed strings should not be lost to one malformed response.
      if(options.signal?.aborted)throw error;
      failures.push({nodeId:node.id,errorClass:error instanceof Error?error.message.slice(0,100):'UNKNOWN'});
    }
  }
  return {findings,suppressed,failures,reviewed,diagnostics:[...diagnosticCounts.entries()].map(([code,count])=>({code,count}))};
}

export type { z };
