import { CandidateSchema,ReviewerResponseSchema,VerificationSchema,candidateDigest } from '@humanize/domain';
import type { CandidateFinding,ContentNode,EvidenceRecord,ModelProvider,ReviewSnapshot,ValidatedFinding,z } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';
import { REVIEWER_SYSTEM,VERIFIER_SYSTEM,reviewerInput,verifierInput } from './prompt.js';
import { routeNode } from './router.js';
import type { CategoryName,RoutingOptions } from './router.js';

export type SuppressionReason=
  |'text_not_in_node'|'foreign_node'|'category_not_routed'|'evidence_not_supplied'
  |'below_confidence'|'verifier_suppressed'|'verifier_missing_verdict'|'below_minimum_severity';

/**
 * Language that belongs to the review machinery rather than to the author. A verifier that
 * narrates its own checking, or names a candidate, is describing the process instead of the
 * writing.
 */
const META_COMMENTARY=/\b(?:the\s+(?:proposed\s+)?(?:finding|candidate)|candidate\s*id|corrected\s*explanation|reason\s*if\s*suppressed|evidence\s+(?:id|identifier)|the\s+reviewer|this\s+(?:review|verification)|suppress(?:ed|ion)?\b)/iu;
const WORDS=(value:string):string[]=>value.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[];
/** Long enough that ordinary prose will not collide, short enough to catch a quoted clause. */
const ECHO_LENGTH=8;

/**
 * Rejects a verifier "correction" that is not actually addressed to the author.
 *
 * A weaker model repeats its own instructions back: one live run published the sentence
 * "state the problem with their writing directly, in one or two sentences, addressed to them"
 * into a real pull request, because the correction was checked only for placeholders and
 * emptiness. Overlap is measured against the system prompt itself rather than a blacklist, so
 * the check keeps working when the prompt is reworded.
 */
export function authorFacing(correction:string,system:string):boolean {
  if(META_COMMENTARY.test(correction))return false;
  const corrected=WORDS(correction);
  if(corrected.length<ECHO_LENGTH)return true;
  const instructions=WORDS(system);
  const echoes=new Set<string>();
  for(let index=0;index+ECHO_LENGTH<=instructions.length;index++)echoes.add(instructions.slice(index,index+ECHO_LENGTH).join(' '));
  for(let index=0;index+ECHO_LENGTH<=corrected.length;index++)if(echoes.has(corrected.slice(index,index+ECHO_LENGTH).join(' ')))return false;
  return true;
}

/** Placeholders a replacement must preserve, found in the reviewed text. */
const placeholdersOf=(value:string):string[]=>[...value.matchAll(/\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[^{}]+\}|%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]|%%/g)].map(match=>match[0]).sort();

export interface SuppressedCandidate { nodeId:string; category:string; reason:SuppressionReason; }
export interface NodeSignal { ruleId:string; description:string; category:CategoryName; severity:'major'|'minor'|'nit'; start:number; end:number; matchedText:string; blocking:boolean; standalone?:boolean; evidence:EvidenceRecord; }

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
 * Deterministic gate between a model and a published finding. A candidate survives only if it
 * names the node under review, quotes text that genuinely occurs in that node, cites evidence
 * that was actually supplied, and stays inside the categories the router selected. Source
 * coordinates are attached here from the node; a model never supplies them (INV-004, INV-014).
 */
function validateCandidate(candidate:CandidateFinding,node:ContentNode,routed:readonly CategoryName[],evidence:ReadonlyMap<string,EvidenceRecord>):SuppressionReason|null {
  if(candidate.nodeId!==node.id)return 'foreign_node';
  if(!node.text.includes(candidate.exactText))return 'text_not_in_node';
  if(!routed.includes(candidate.category))return 'category_not_routed';
  for(const reference of candidate.evidence)if(!evidence.has(reference.id))return 'evidence_not_supplied';
  return null;
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

    // A blocking violation is a customer policy; a standalone signal is an objectively
    // countable observation (ADR-037). Neither needs a model to agree that it is present.
    for(const signal of signals.filter(entry=>entry.blocking||entry.standalone===true)){
      findings.push({
        nodeId:node.id,category:signal.category,severity:signal.severity,confidence:1,
        exactText:signal.matchedText,explanation:signal.description,
        evidence:[{id:signal.evidence.id,quote:signal.matchedText}],replacement:null,requiresVerification:false,
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
      input:reviewerInput({node,categories:routing.categories,evidence:[...evidence.values()],ruleNotes:signals.map(entry=>entry.description),marker}),
      schema:ReviewerResponseSchema,timeoutMs,traceContext:{traceId:snapshot.configHash},
      ...(options.signal?{signal:options.signal}:{}),
    });

    const accepted:CandidateFinding[]=[];
    for(const raw of response.data.candidates){
      const candidate=CandidateSchema.parse(raw);
      const reason=validateCandidate(candidate,node,routing.categories,evidence);
      if(reason){suppressed.push({nodeId:node.id,category:candidate.category,reason});continue;}
      if(candidate.confidence<threshold){suppressed.push({nodeId:node.id,category:candidate.category,reason:'below_confidence'});continue;}
      if(SEVERITY_RANK[candidate.severity]<minimum){suppressed.push({nodeId:node.id,category:candidate.category,reason:'below_minimum_severity'});continue;}
      accepted.push(candidate);
    }
    if(!accepted.length)continue;

    // A separate invocation, with its own system prompt and only the surviving candidates.
    const verdicts=await ports.verifier.generateStructured({
      model:ports.verifierModel,system:VERIFIER_SYSTEM,
      input:verifierInput({node,evidence:[...evidence.values()],marker,
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
      // rather than trusted: a correction that drops a placeholder or empties the explanation
      // is discarded and the reviewer's original stands.
      const correctedExplanation=verdict.correctedExplanation?.trim();
      // A correction is model output like any other. One that echoes the instructions or
      // narrates the verification is discarded in favour of the reviewer's original, because
      // the explanation is the only part of a finding the author actually reads.
      const usableCorrection=correctedExplanation&&authorFacing(correctedExplanation,VERIFIER_SYSTEM);
      if(correctedExplanation&&!usableCorrection)diagnosticCounts.set('CORRECTION_NOT_AUTHOR_FACING',(diagnosticCounts.get('CORRECTION_NOT_AUTHOR_FACING')??0)+1);
      const explanation=usableCorrection?correctedExplanation:candidate.explanation;
      const corrected=verdict.correctedReplacement;
      const preservesPlaceholders=corrected===null||corrected===undefined
        ||JSON.stringify(placeholdersOf(candidate.exactText))===JSON.stringify(placeholdersOf(corrected));
      const replacement=corrected!==null&&corrected!==undefined&&preservesPlaceholders&&corrected.trim()
        ?corrected:candidate.replacement;
      if(!preservesPlaceholders)diagnosticCounts.set('CORRECTION_DROPPED_PLACEHOLDER',(diagnosticCounts.get('CORRECTION_DROPPED_PLACEHOLDER')??0)+1);
      findings.push({
        ...candidate,explanation,replacement,
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
