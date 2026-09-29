import { CandidateSchema,LIMITS,ReviewerResponseSchema,VerificationSchema,candidateDigest } from '@humanize/domain';
import type { CandidateFinding,ContentNode,EvidenceRecord,ModelProvider,ReviewSnapshot,ValidatedFinding,z } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';
import { REVIEWER_SYSTEM,VERIFIER_SYSTEM,reviewerBatchInput,reviewerInput,verifierBatchInput,verifierInput } from './prompt.js';
import type { ReviewerUnitInput,VerifierUnitInput } from './prompt.js';
import { routeNode } from './router.js';
import type { CategoryName,RoutingDecision,RoutingOptions } from './router.js';
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
  /**
   * The categories and severity floor for one node, when they differ by path. Configuration can
   * scope both to a set of files, so a single value for the whole review would apply one file's
   * rules to another. Absent, `enabled` and `minimumSeverity` apply to every node.
   */
  scopeFor?:(node:ContentNode)=>{enabled:Readonly<Record<CategoryName,boolean>>;minimumSeverity:'major'|'minor'|'nit'};
  confidenceThreshold?:number;
  verificationThreshold?:number;
  timeoutMs?:number;
  signal?:AbortSignal;
  marker?:string;
}
export interface NodeFailure { nodeId:string; errorClass:string; }
export interface ReviewOutcome { findings:ValidatedFinding[]; suppressed:SuppressedCandidate[]; failures:NodeFailure[]; reviewed:number; diagnostics:{code:string;count:number}[]; }

const SEVERITY_RANK={nit:0,minor:1,major:2} as const;
/** The architecture starts both thresholds at 0.90; these are heuristics, not probabilities. */
/**
 * Two different numbers, because they mean different things.
 *
 * A reviewer's confidence is self-reported by a model about its own output, which the
 * architecture already calls a heuristic rather than a calibrated probability. Cutting at 0.90
 * discarded candidates before the verifier could judge them, doing the verifier's job with far
 * less information: measured across 35 labelled cases on two models, that threshold was the
 * only thing suppressing anything, and lowering it recovered real findings while precision
 * stayed at 100%.
 *
 * A verifier's confidence is a considered judgement made against the evidence, so it keeps the
 * high bar. The reviewer proposes broadly; the verifier decides (ADR-042).
 */
export const DEFAULT_CONFIDENCE=0.6;
export const DEFAULT_VERIFICATION_CONFIDENCE=0.9;

function boundaryMarker():string {
  // Unguessable per review, so quoted repository text cannot terminate its own fence.
  return `hz-${fingerprint([Math.random(),Date.now()]).slice(0,24)}`;
}

/**
 * Deliberately pessimistic. Measured against llama3.2 on 2026-09-28, rendered review prompts ran
 * 2.4 to 3.0 characters per token, because evidence identifiers are hex digests that tokenize
 * badly; the four-characters-per-token rule retrieval uses put a 13,886-token batch at 10,545 and
 * sent it as one call, past the input budget. Overestimating only makes batches smaller.
 */
export const estimatePromptTokens=(text:string):number=>Math.ceil(text.length/2);
const estimateTokens=estimatePromptTokens;

/**
 * Groups items into model batches of at most `LIMITS.nodeBatch`, and at most the input token
 * budget once rendered. An item that alone exceeds the budget still goes, alone, exactly as it
 * would have before batching; Ollama's window is sized to the budget, so overflowing it would
 * silently evict the system prompt rather than fail (see OllamaProvider).
 */
export function packBatches<T>(items:readonly T[],cost:(item:T)=>number,budget:number=LIMITS.contextTokens,size:number=LIMITS.nodeBatch):T[][] {
  const batches:T[][]=[];
  let current:T[]=[],used=0;
  for(const item of items){
    const itemCost=cost(item);
    if(current.length&&(current.length>=size||used+itemCost>budget)){batches.push(current);current=[];used=0;}
    current.push(item);used+=itemCost;
  }
  if(current.length)batches.push(current);
  return batches;
}

interface Prepared { node:ContentNode; unit:ReviewableUnit; routing:RoutingDecision; minimum:number; signals:NodeSignal[]; evidence:Map<string,EvidenceRecord>; contextLabel:string; }

/**
 * Reviews changed content in batches. Deterministic blocking-rule violations become findings
 * without a model. Model-proposed findings are validated, then independently verified by a
 * separate invocation — separate even when reviewer and verifier are the same model, because a
 * single call cannot both propose and impartially check.
 *
 * Up to `LIMITS.nodeBatch` nodes share one reviewer call, and only nodes with surviving
 * candidates reach the verifier, again batched. A batch call that fails is retried node by node,
 * so one node that defeats the model costs only that node, as it did when every call was single.
 */
export async function reviewNodes(snapshot:ReviewSnapshot,nodes:readonly ContentNode[],ports:ReviewPorts,options:ReviewOptions):Promise<ReviewOutcome> {
  const marker=options.marker??boundaryMarker();
  const threshold=options.confidenceThreshold??DEFAULT_CONFIDENCE;
  const verificationThreshold=options.verificationThreshold??DEFAULT_VERIFICATION_CONFIDENCE;
  const scopeOf=(node:ContentNode)=>options.scopeFor?.(node)??{enabled:options.enabled,minimumSeverity:options.minimumSeverity??'minor'};
  const timeoutMs=options.timeoutMs??60000;
  const findingsByNode=new Map<string,ValidatedFinding[]>(nodes.map(node=>[node.id,[]]));
  const suppressed:SuppressedCandidate[]=[];
  const failed=new Map<string,string>();
  const diagnosticCounts=new Map<string,number>();
  const count=(code:string)=>diagnosticCounts.set(code,(diagnosticCounts.get(code)??0)+1);
  const errorClass=(error:unknown)=>error instanceof Error?error.message.slice(0,100):'UNKNOWN';
  const prepared:Prepared[]=[];
  let reviewed=0;

  for(const node of nodes){
    options.signal?.throwIfAborted();
    if(node.repositoryId!==snapshot.repositoryId||node.commitSha!==snapshot.headSha)throw Error('NODE_OUT_OF_SNAPSHOT');
    const scope=scopeOf(node);
    const routing=routeNode(node,{...options,enabled:scope.enabled});
    const signals=ports.rules(node);

    // A blocking violation is a customer policy; a standalone signal is an objectively
    // countable observation (ADR-037). Neither needs a model to agree that it is present.
    for(const signal of signals.filter(entry=>entry.blocking||entry.standalone===true)){
      findingsByNode.get(node.id)!.push({
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
      const evidence=new Map((await ports.context(node)).map(record=>[record.id,record]));
      for(const signal of signals)evidence.set(signal.evidence.id,signal.evidence);
      // Repository-specific preparation ends here: everything downstream that reaches the model
      // or validates its output does so through this minimal, source-agnostic shape.
      prepared.push({node,unit:{id:node.id,text:node.text,placeholders:node.placeholders},routing,minimum:SEVERITY_RANK[scope.minimumSeverity],signals,evidence,
        contextLabel:`Content kind: ${node.kind}. Source: ${node.filePath}.`});
    }catch(error){
      if(options.signal?.aborted)throw error;
      failed.set(node.id,errorClass(error));
    }
  }

  const reviewerUnit=(item:Prepared):ReviewerUnitInput=>({unit:item.unit,contextLabel:item.contextLabel,categories:item.routing.categories,evidence:[...item.evidence.values()],ruleNotes:item.signals.map(entry=>entry.description)});
  const request=(size:number)=>({timeoutMs:timeoutMs*size,traceContext:{traceId:snapshot.configHash},...(options.signal?{signal:options.signal}:{})});

  /**
   * Runs one batch call, falling back to one call per item when a multi-item call fails. A
   * failure is recorded only against an item whose own single call failed.
   */
  async function withFallback<R>(batch:Prepared[],call:(items:Prepared[])=>Promise<R>,apply:(items:Prepared[],result:R)=>void):Promise<void> {
    // Only the model call is guarded: once a result is in hand it is applied exactly once, so a
    // fallback can never apply the same node's candidates twice.
    const attempt=async(items:Prepared[]):Promise<{result:R}|{error:unknown}>=>{
      try{return {result:await call(items)};}
      catch(error){if(options.signal?.aborted)throw error;return {error};}
    };
    const whole=await attempt(batch);
    if('result' in whole){apply(batch,whole.result);return;}
    if(batch.length===1){failed.set(batch[0]!.node.id,errorClass(whole.error));return;}
    count('MODEL_BATCH_FALLBACK');
    for(const item of batch){
      options.signal?.throwIfAborted();
      const single=await attempt([item]);
      if('result' in single)apply([item],single.result);
      else failed.set(item.node.id,errorClass(single.error));
    }
  }

  // Reviewer: candidates are attributed to the unit they name and validated against that unit.
  const accepted=new Map<string,CandidateFinding[]>();
  const reviewerBatches=packBatches(prepared,item=>estimateTokens(reviewerInput({...reviewerUnit(item),marker})),LIMITS.contextTokens-estimateTokens(REVIEWER_SYSTEM));
  for(const batch of reviewerBatches){
    options.signal?.throwIfAborted();
    await withFallback(batch,async items=>{
      count('REVIEWER_CALLS');
      const input=items.length===1?reviewerInput({...reviewerUnit(items[0]!),marker}):reviewerBatchInput({units:items.map(reviewerUnit),marker});
      return (await ports.reviewer.generateStructured({model:ports.reviewerModel,system:REVIEWER_SYSTEM,input,schema:ReviewerResponseSchema,...request(items.length)})).data;
    },(items,data)=>{
      const byId=new Map(items.map(item=>[item.node.id,item]));
      for(const raw of data.candidates){
        const candidate=CandidateSchema.parse(raw);
        // A candidate naming no unit in this call is foreign: suppressed, never reassigned.
        const item=byId.get(candidate.nodeId)??items[0]!;
        const reason=validateCandidate(candidate,item.unit,item.routing.categories,item.evidence);
        if(reason){suppressed.push({nodeId:item.node.id,category:candidate.category,reason});continue;}
        if(candidate.confidence<threshold){suppressed.push({nodeId:item.node.id,category:candidate.category,reason:'below_confidence'});continue;}
        if(SEVERITY_RANK[candidate.severity]<item.minimum){suppressed.push({nodeId:item.node.id,category:candidate.category,reason:'below_minimum_severity'});continue;}
        accepted.set(item.node.id,[...(accepted.get(item.node.id)??[]),candidate]);
      }
    });
  }

  // Verifier: a separate invocation, with its own system prompt and only surviving candidates.
  const verifierUnit=(item:Prepared):VerifierUnitInput=>({unit:item.unit,evidence:[...item.evidence.values()],
    candidates:(accepted.get(item.node.id)??[]).map(candidate=>({id:candidateDigest(candidate),category:candidate.category,severity:candidate.severity,exactText:candidate.exactText,explanation:candidate.explanation}))});
  const toVerify=prepared.filter(item=>accepted.has(item.node.id));
  const verifierBatches=packBatches(toVerify,item=>estimateTokens(verifierInput({...verifierUnit(item),marker})),LIMITS.contextTokens-estimateTokens(VERIFIER_SYSTEM));
  for(const batch of verifierBatches){
    options.signal?.throwIfAborted();
    await withFallback(batch,async items=>{
      count('VERIFIER_CALLS');
      const input=items.length===1?verifierInput({...verifierUnit(items[0]!),marker}):verifierBatchInput({units:items.map(verifierUnit),marker});
      return VerificationSchema.parse((await ports.verifier.generateStructured({model:ports.verifierModel,system:VERIFIER_SYSTEM,input,schema:VerificationSchema,...request(items.length)})).data);
    },(items,data)=>{
      const byIdentity=new Map(data.results.map(result=>[result.candidateId,result]));
      for(const item of items)for(const candidate of accepted.get(item.node.id)??[]){
        const verdict=byIdentity.get(candidateDigest(candidate));
        // No verdict means unverified, and unverified never publishes.
        if(!verdict){suppressed.push({nodeId:item.node.id,category:candidate.category,reason:'verifier_missing_verdict'});continue;}
        if(!verdict.publish||verdict.confidence<verificationThreshold){suppressed.push({nodeId:item.node.id,category:candidate.category,reason:'verifier_suppressed'});continue;}
        // A verifier's corrections are model output like any other, so they are revalidated
        // rather than trusted: a correction that drops a placeholder, or that echoes the
        // instructions instead of addressing the author, is discarded and the reviewer's
        // original stands. This check is source-agnostic, so it lives in the common core.
        const applied=applyVerification(candidate,verdict,VERIFIER_SYSTEM);
        if(applied.notAuthorFacing)count('CORRECTION_NOT_AUTHOR_FACING');
        if(applied.placeholderDropped)count('CORRECTION_DROPPED_PLACEHOLDER');
        findingsByNode.get(item.node.id)!.push({
          ...candidate,explanation:applied.explanation,replacement:applied.replacement,
          fingerprint:fingerprint(['finding',item.node.stableKey,candidate.category,candidate.exactText]),
          node:item.node,evidenceRecords:candidate.evidence.map(reference=>item.evidence.get(reference.id)!),
          deterministic:false,blocking:false,verificationConfidence:verdict.confidence,
        });
      }
    });
  }

  // Findings keep node order, deterministic first within a node, as when nodes ran one at a time.
  return {
    findings:nodes.flatMap(node=>findingsByNode.get(node.id)??[]),suppressed,
    failures:[...failed.entries()].map(([nodeId,errorClass])=>({nodeId,errorClass})),reviewed,
    diagnostics:[...diagnosticCounts.entries()].map(([code,count])=>({code,count})),
  };
}

export type { z };
