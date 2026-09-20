import { LIMITS } from '@humanize/domain';
import type { ContentNode,EvidenceRecord,RetrievalPort,RetrievalQuery,ReviewSnapshot } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';
import { bm25,tokenize,trigramSimilarity } from './lexical.js';

export * from './lexical.js';

export const MAX_QUOTE_CHARS=600;
export const NEAR_DUPLICATE_THRESHOLD=0.8;
/** Deliberately coarse: a stable, provider-neutral bound, not a tokenizer. */
export const estimateTokens=(text:string):number=>Math.ceil(text.length/4);

interface Indexed { node:ContentNode; tokens:string[]; frequencies:Map<string,number>; }

function evidence(node:ContentNode,description:string):EvidenceRecord {
  const quote=node.text.slice(0,MAX_QUOTE_CHARS);
  return {
    id:fingerprint(['evidence',node.id,description]),type:'repo_content',description,
    filePath:node.filePath,line:node.startLine,quote,nodeId:node.id,
    revision:node.commitSha,contentHash:fingerprint([node.blobSha,node.startOffset,node.endOffset,node.text]),
  };
}

/**
 * Lexical retrieval over the ContentNodes of a single review, held in memory for the life of
 * that review and nothing longer. It needs no content tables and no embeddings, so a review
 * works in ephemeral retention mode and with vectors disabled; semantic retrieval is an
 * accelerator layered on top, never a dependency.
 */
export class EphemeralContextIndex implements RetrievalPort {
  private readonly documents=new Map<string,Indexed>();
  private readonly postings=new Map<string,Set<string>>();
  private totalLength=0;
  readonly repositoryId:string;
  readonly commitSha:string;

  constructor(snapshot:Pick<ReviewSnapshot,'repositoryId'|'headSha'>,nodes:readonly ContentNode[]){
    this.repositoryId=snapshot.repositoryId;this.commitSha=snapshot.headSha;
    for(const node of nodes){
      // Scoping is a tenant boundary, not an optimization: content from another repository or
      // another commit must never become evidence about this review.
      if(node.repositoryId!==this.repositoryId||node.commitSha!==this.commitSha)throw Error('NODE_OUT_OF_SNAPSHOT');
      if(this.documents.has(node.id))continue;
      const tokens=tokenize(node.normalizedText||node.text);
      const frequencies=new Map<string,number>();
      for(const token of tokens){
        frequencies.set(token,(frequencies.get(token)??0)+1);
        let posting=this.postings.get(token);
        if(!posting){posting=new Set();this.postings.set(token,posting);}
        posting.add(node.id);
      }
      this.documents.set(node.id,{node,tokens,frequencies});
      this.totalLength+=tokens.length;
    }
  }

  get size():number {return this.documents.size;}

  private rank(text:string,limit:number,exclude:ReadonlySet<string>):Indexed[] {
    const queryTokens=new Set(tokenize(text));
    if(!queryTokens.size)return [];
    const average=this.totalLength/(this.documents.size||1);
    const scored:{document:Indexed;score:number}[]=[];
    for(const document of this.documents.values()){
      if(exclude.has(document.node.id))continue;
      let score=0;
      for(const token of queryTokens){
        const frequency=document.frequencies.get(token);
        if(frequency)score+=bm25(frequency,document.tokens.length,average,this.postings.get(token)?.size??0,this.documents.size);
      }
      if(score>0)scored.push({document,score});
    }
    // Stable key breaks ties so the same input always produces the same context.
    scored.sort((left,right)=>right.score-left.score||left.document.node.stableKey.localeCompare(right.document.node.stableKey,'en'));
    return scored.slice(0,Math.max(0,Math.min(limit,LIMITS.nodeBatch*5))).map(entry=>entry.document);
  }

  async search(query:RetrievalQuery):Promise<EvidenceRecord[]> {
    const exclude=new Set(query.excludeNodeId===undefined?[]:[query.excludeNodeId]);
    return this.rank(query.text,query.limit,exclude).map(document=>evidence(document.node,'Related repository content'));
  }

  /** Near-duplicate detection, the lexical signal behind repeated marketing or documentation. */
  nearDuplicates(node:ContentNode,threshold=NEAR_DUPLICATE_THRESHOLD):EvidenceRecord[] {
    const matches:{document:Indexed;similarity:number}[]=[];
    for(const document of this.documents.values()){
      if(document.node.id===node.id)continue;
      const similarity=trigramSimilarity(node.normalizedText||node.text,document.node.normalizedText||document.node.text);
      if(similarity>=threshold)matches.push({document,similarity});
    }
    matches.sort((left,right)=>right.similarity-left.similarity||left.document.node.stableKey.localeCompare(right.document.node.stableKey,'en'));
    return matches.map(match=>evidence(match.document.node,`Near-duplicate of reviewed content (${match.similarity.toFixed(2)})`));
  }

  neighbours(node:ContentNode,limit=5):EvidenceRecord[] {
    return [...this.documents.values()]
      .filter(document=>document.node.id!==node.id&&document.node.filePath===node.filePath)
      .sort((left,right)=>Math.abs(left.node.startLine-node.startLine)-Math.abs(right.node.startLine-node.startLine)||left.node.startLine-right.node.startLine)
      .slice(0,limit)
      .map(document=>evidence(document.node,'Nearby content in the same file'));
  }
}

export interface ContextRequest {
  node:ContentNode;
  index:EphemeralContextIndex;
  rules?:readonly EvidenceRecord[];
  approvedVoice?:readonly EvidenceRecord[];
  tokenBudget?:number;
}
export interface BuiltContext { evidence:EvidenceRecord[]; tokens:number; truncated:boolean; }

/**
 * Assembles bounded context in the specified priority order: the changed node's immediate
 * neighbourhood, then configured rules and approved voice, then the strongest related
 * repository evidence. The budget is a hard stop — the goal is never to send the repository
 * to a model — so lower-priority evidence is dropped rather than the budget stretched.
 */
export async function buildContext(request:ContextRequest):Promise<BuiltContext> {
  const budget=request.tokenBudget??LIMITS.contextTokens;
  const tiers:EvidenceRecord[][]=[
    request.index.neighbours(request.node),
    [...(request.rules??[]),...(request.approvedVoice??[])],
    request.index.nearDuplicates(request.node),
    await request.index.search({text:request.node.normalizedText||request.node.text,limit:LIMITS.nodeBatch,excludeNodeId:request.node.id}),
  ];
  const evidence:EvidenceRecord[]=[];
  const seen=new Set<string>();
  let tokens=0,truncated=false;
  for(const tier of tiers)for(const record of tier){
    if(seen.has(record.id))continue;
    const cost=estimateTokens(`${record.description}${record.quote??''}`);
    if(tokens+cost>budget){truncated=true;continue;}
    seen.add(record.id);evidence.push(record);tokens+=cost;
  }
  return {evidence,tokens,truncated};
}
