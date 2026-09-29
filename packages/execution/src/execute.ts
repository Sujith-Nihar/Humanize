import { LIMITS } from '@humanize/domain';
import type { ContentNode,ModelProvider,ReviewResult,ReviewSnapshot } from '@humanize/domain';
import { GitRepository,classify,withWorkspace } from '@humanize/scanner';
import { extract } from '@humanize/extractors';
import { parseFileDiff } from '@humanize/github';
import { EphemeralContextIndex,buildContext } from '@humanize/retrieval';
import { evaluateRules } from '@humanize/rules';
import { reviewNodes,routeNode } from '@humanize/review';
import { buildSuggestion } from '@humanize/suggestions';
import type { NodeSignal } from '@humanize/review';
import { enabledCategories,settingsForPath } from '@humanize/config';
import { snapshotDigest } from '@humanize/domain';

/**
 * Where and how large, never what. What to review — categories, severity floor, include and
 * exclude, visible props, avoided phrases, terminology and blocking rules — comes only from the
 * snapshot, which was fixed from administrator policy and trusted configuration when the run was
 * created. An executor that took them from its own configuration could review differently from
 * what the customer set, and did (ADR-043).
 */
export interface ExecutionConfig {
  maxFileBytes?:number;
  workspaceRoot?:string;
}
/**
 * What one execution needs from outside itself: the models, and a read-only repository token.
 * Which providers are behind them is the caller's decision, because it is the caller that
 * knows whether this review runs on the customer's own hardware or in the cloud. They are
 * separate because administrator policy may name a different provider for each role; a
 * private review passes the same local model twice.
 */
export interface ExecutionPorts { reviewer:ModelProvider; verifier:ModelProvider; token:string; }
export interface ExecutionReport { result:ReviewResult; inspectedFiles:number; extractedNodes:number; changedNodes:number; }

/**
 * The rules a review applies to a node: those the snapshot's settings configure for its path.
 * Exported because publication recomputes deterministic findings with exactly these rules, and
 * two compositions of them could drift apart (ADR-043).
 */
export function configuredRules(scope:ReviewSnapshot['review']):(node:ContentNode)=>NodeSignal[] {
  return node=>{
    const {avoid,terminology,blockingRules}=settingsForPath(scope,node.filePath);
    return evaluateRules(node,{avoid,terminology,blockingRules}) as NodeSignal[];
  };
}

/** Lines added on the right-hand side of the diff; a review only judges what the PR changed. */
function changedLines(patch:string,newPath:string|null):Set<number> {
  const lines=new Set<number>();
  if(newPath===null)return lines;
  try{for(const line of parseFileDiff(null,newPath,patch).addedLines)lines.add(line);}catch{/* an unparseable patch reviews nothing */}
  return lines;
}

/**
 * Runs one review inside an ephemeral workspace. The repository is cloned read-only with the
 * job-scoped token, never executed, and the workspace is destroyed on every exit path.
 * Content leaves this function only as ContentNodes and findings; no file is retained.
 *
 * This is the whole review, and both executors share it: a private review on a customer's
 * runner and a cloud review differ in which model they are handed and who publishes the
 * result, not in how content is found, judged or checked.
 */
export async function executeReview(
  snapshot:ReviewSnapshot,runId:string,ports:ExecutionPorts,config:ExecutionConfig,signal?:AbortSignal,
):Promise<ExecutionReport> {
  return withWorkspace(async workspace=>{
    const repository=await GitRepository.acquire(workspace,{
      owner:snapshot.owner,repository:snapshot.repository,token:ports.token,
      headSha:snapshot.headSha,baseSha:snapshot.baseSha,pullNumber:snapshot.pullNumber,...(signal?{signal}:{}),
    });
    const mergeBase=await repository.mergeBase(snapshot.baseSha,snapshot.headSha);
    const changes=await repository.changes(mergeBase,snapshot.headSha);
    const changedByPath=new Map(changes.filter(change=>change.newPath).map(change=>[change.newPath!,changedLines(change.patch,change.newPath)]));

    const scope=snapshot.review;
    const settings=(path:string)=>settingsForPath(scope,path);
    const maxFileBytes=config.maxFileBytes??LIMITS.fileBytes;
    const scanFor=(path:string)=>{const found=settings(path);return {include:[...found.include],exclude:[...found.exclude],maxFileBytes};};

    const tree=await repository.tree(snapshot.headSha);
    const nodes:ContentNode[]=[];
    const sources=new Map<string,string>();
    const diagnostics=new Map<string,number>();
    let inspectedFiles=0;
    for(const entry of tree){
      signal?.throwIfAborted();
      if(entry.type!=='blob')continue;
      // Every tracked file is classified, but classification happens on the path first:
      // reading a blob in order to classify it would pull every file in the repository out
      // of the blobless clone, including the binaries the classifier is about to reject.
      if(classify(entry,undefined,scanFor(entry.path)).classification!=='SUPPORTED_CONTENT')continue;
      // Only now is content fetched, and `blob` applies the size cap to this one file.
      const bytes=await repository.blob(entry.sha,maxFileBytes).catch(()=>undefined);
      if(!bytes){diagnostics.set('FILE_UNREADABLE',(diagnostics.get('FILE_UNREADABLE')??0)+1);continue;}
      // Re-classified with content, which is what detects a binary or generated file whose
      // path looked reviewable.
      const inventory=classify({...entry,size:bytes.byteLength},bytes,scanFor(entry.path));
      if(inventory.classification!=='SUPPORTED_CONTENT')continue;
      inspectedFiles++;
      const text=bytes.toString('utf8');
      const {visibleProps,visibleCalls}=settings(entry.path);
      const extraction=extract({repositoryId:snapshot.repositoryId,commitSha:snapshot.headSha,blobSha:entry.sha,filePath:entry.path,source:text,
        visibleProps:[...visibleProps],visibleCalls:[...visibleCalls]});
      if(extraction.nodes.length)sources.set(entry.path,text);
      nodes.push(...extraction.nodes);
      for(const diagnostic of extraction.diagnostics)diagnostics.set(diagnostic.code,(diagnostics.get(diagnostic.code)??0)+1);
    }

    const index=new EphemeralContextIndex(snapshot,nodes);
    const rulesFor=configuredRules(scope);
    const changed=nodes.filter(node=>{
      const lines=changedByPath.get(node.filePath);
      if(!lines)return false;
      for(let line=node.startLine;line<=node.endLine;line++)if(lines.has(line))return true;
      return false;
    // A node is worth passing on when a model may review it, or when a rule the customer
    // configured applies to it regardless: a blocking rule holds even on paths where every
    // review category is switched off.
    }).filter(node=>routeNode(node,{enabled:enabledCategories(settings(node.filePath))}).eligible
      ||rulesFor(node).some(entry=>entry.blocking||entry.standalone===true)).slice(0,LIMITS.nodeBatch);

    const outcome=await reviewNodes(snapshot,changed,{
      reviewer:ports.reviewer,reviewerModel:snapshot.reviewer.model,
      verifier:ports.verifier,verifierModel:snapshot.verifier.model,
      context:async node=>(await buildContext({node,index})).evidence,
      rules:rulesFor,
    },{
      enabled:enabledCategories(scope.settings),minimumSeverity:scope.settings.minimumSeverity,
      scopeFor:node=>{const found=settings(node.filePath);return {enabled:enabledCategories(found),minimumSeverity:found.minimumSeverity};},
      ...(signal?{signal}:{}),
    });

    // Pipeline diagnostics (model call counts, batch fallbacks, discarded corrections) travel
    // with the result so a run records what the review actually cost.
    for(const diagnostic of outcome.diagnostics)diagnostics.set(diagnostic.code,(diagnostics.get(diagnostic.code)??0)+diagnostic.count);
    for(const suppressed of outcome.suppressed)diagnostics.set(`SUPPRESSED_${suppressed.reason.toUpperCase()}`,(diagnostics.get(`SUPPRESSED_${suppressed.reason.toUpperCase()}`)??0)+1);
    for(const failure of outcome.failures)diagnostics.set(`REVIEW_FAILED_${failure.errorClass.replace(/[^A-Z_]/gi,'_').toUpperCase()}`.slice(0,100),(diagnostics.get(`REVIEW_FAILED_${failure.errorClass.replace(/[^A-Z_]/gi,'_').toUpperCase()}`.slice(0,100))??0)+1);
    const evidence=new Map(outcome.findings.flatMap(finding=>finding.evidenceRecords.map(record=>[record.id,record])));
    // Evidence usually quotes content the pull request did not change. Those nodes travel with
    // the result so their quotations can be checked; sending only the changed nodes made every
    // finding that cited context fail validation and took the whole review down with it.
    const reviewed=new Set(changed.map(node=>node.id));
    const byId=new Map(nodes.map(node=>[node.id,node]));
    const contextNodes=[...new Set([...evidence.values()].map(record=>record.nodeId).filter((id):id is string=>id!==undefined&&!reviewed.has(id)))]
      .map(id=>byId.get(id)).filter((node):node is ContentNode=>node!==undefined);
    // A replacement becomes a one-click suggestion only when every safety check passes;
    // anything else stays a comment, which is always publishable.
    const suggestions=new Map<string,string>();
    for(const finding of outcome.findings){
      const source=sources.get(finding.node.filePath);
      if(finding.replacement===null||source===undefined)continue;
      const built=buildSuggestion({node:finding.node,replacement:finding.replacement,source,headSha:snapshot.headSha,
        changedLines:[...(changedByPath.get(finding.node.filePath)??[])]});
      if(built.published)suggestions.set(finding.fingerprint,built.suggestion.replacement);
      else for(const reason of built.reasons)diagnostics.set(`SUGGESTION_${reason}`,(diagnostics.get(`SUGGESTION_${reason}`)??0)+1);
    }
    diagnostics.set('SUGGESTIONS_OFFERED',suggestions.size);

    return {
      inspectedFiles,extractedNodes:nodes.length,changedNodes:changed.length,
      result:{
        version:1,runId,snapshotHash:snapshotDigest(snapshot),
        nodes:changed,contextNodes,candidates:outcome.findings.map(finding=>({
          nodeId:finding.nodeId,category:finding.category,severity:finding.severity,confidence:finding.confidence,
          exactText:finding.exactText,explanation:finding.explanation,evidence:finding.evidence,
          replacement:finding.replacement,requiresVerification:finding.requiresVerification,
        })),
        evidence:[...evidence.values()],
        verification:{results:[]},
        diagnostics:[...diagnostics.entries()].map(([code,count])=>({code:code.slice(0,100),count})).slice(0,100),
      },
    };
  },config.workspaceRoot);
}
