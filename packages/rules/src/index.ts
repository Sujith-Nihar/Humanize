import type { Category,ContentNode,EvidenceRecord,Severity,z } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';

export interface RuleSignal {
  ruleId:string;
  category:z.infer<typeof Category>;
  severity:z.infer<typeof Severity>;
  /** Offsets are relative to the node text, so a caller maps them to source deterministically. */
  start:number;
  end:number;
  matchedText:string;
  description:string;
  blocking:boolean;
  /** Objectively countable, so it may be reported without model agreement (ADR-037). */
  standalone?:boolean;
  evidence:EvidenceRecord;
}

export interface RuleConfiguration {
  avoid?:readonly string[];
  terminology?:Readonly<Record<string,string>>;
  blockingRules?:readonly {type:'forbidden_phrase';phrase:string}[];
}

/**
 * Low-information promotional wording. These are review-worthy writing observations, never
 * evidence of who or what wrote the text: the product reports observable problems with the
 * writing and must never claim a passage was machine authored (INV-006).
 */
const PROMOTIONAL=[
  'unlock unprecedented','unprecedented potential','cutting-edge','state-of-the-art','game-changing','game changing',
  'revolutionary','seamlessly integrate','seamless integration','robust solution','powerful solution','world-class',
  'best-in-class','next-generation','take it to the next level','in today’s fast-paced','in today\'s fast-paced',
  'leverage the power of','harness the power of','elevate your','supercharge your','delve into','a testament to',
];
const PADDING=[
  'provides users with the ability to','provides you with the ability to','gives users the ability to',
  'it is important to note that','it should be noted that','it is worth noting that',
  'in order to get started','you will first need to begin by','needless to say',
  'at the end of the day','when it comes to','the fact that','in the event that',
  'a wide variety of','a wide range of','due to the fact that','for all intents and purposes',
];
const SUPERLATIVES=/\b(?:most|best|greatest|ultimate|perfect|flawless|effortless|incredible|amazing|revolutionary|unparalleled|unmatched)\b/giu;
const ADVERBS=/\b\w+ly\b/giu;

const escape=(value:string):string=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/**
 * Matches a phrase across ordinary English inflection: leverage, leverages and leveraging are
 * one phrase for review purposes. Literal matching silently missed those variants, which put
 * a passage below the cluster threshold and produced no finding at all.
 */
const inflected=(phrase:string):RegExp=>{
  const pattern=phrase.split(/\s+/).map(word=>{
    if(word.length<5||/[^a-z]/i.test(word))return escape(word);
    const stem=word.replace(/(?:e|ed|es|ing|s)$/i,'');
    return stem.length<4?escape(word):`${escape(stem)}(?:e|ed|es|ing|s)?`;
  }).join('\\s+');
  return new RegExp(pattern,'giu');
};
const sentences=(text:string):{text:string;start:number}[]=>{
  const result:{text:string;start:number}[]=[];
  const pattern=/[^.!?]+[.!?]*/gu;
  for(const match of text.matchAll(pattern)){
    const trimmed=match[0].trimStart();
    if(trimmed.length)result.push({text:trimmed,start:(match.index??0)+(match[0].length-trimmed.length)});
  }
  return result;
};

function signal(node:ContentNode,input:Omit<RuleSignal,'evidence'|'matchedText'>&{matchedText?:string}):RuleSignal {
  const matchedText=input.matchedText??node.text.slice(input.start,input.end);
  return {
    ...input,matchedText,
    evidence:{
      id:fingerprint(['rule',node.id,input.ruleId,input.start,input.end]),type:'rule',description:input.description,
      filePath:node.filePath,line:node.startLine,quote:matchedText,nodeId:node.id,ruleId:input.ruleId,
      revision:node.commitSha,contentHash:fingerprint([node.blobSha,input.start,input.end,matchedText]),
    },
  };
}

/**
 * Deterministic content signals. Every span comes from the node's own text, so a finding can
 * always be anchored to real source without trusting a model for coordinates (INV-004,
 * INV-014). Signals are evidence for review, not findings in themselves.
 */
export function evaluateRules(node:ContentNode,config:RuleConfiguration={}):RuleSignal[] {
  const signals:RuleSignal[]=[];
  const text=node.text;

  for(const phrase of PROMOTIONAL){
    for(const match of text.matchAll(inflected(phrase))){
      const start=match.index??0;
      signals.push(signal(node,{ruleId:`promotional:${phrase}`,category:'ai_like_generic',severity:'minor',start,end:start+match[0].length,description:'Low-information promotional wording',blocking:false}));
    }
  }

  for(const phrase of PADDING){
    for(const match of text.matchAll(inflected(phrase))){
      const start=match.index??0;
      // Padding is words doing no work; it is countable, so it can stand alone.
      signals.push(signal(node,{ruleId:`padding:${phrase}`,category:'clarity',severity:'minor',start,end:start+match[0].length,
        description:`Padded phrasing: "${match[0]}"`,blocking:false,standalone:true}));
    }
  }

  for(const phrase of config.avoid??[]){
    for(const match of text.matchAll(new RegExp(escape(phrase),'giu'))){
      const start=match.index??0;
      signals.push(signal(node,{ruleId:`avoid:${phrase}`,category:'approved_voice',severity:'minor',start,end:start+match[0].length,description:`Configured avoided wording: ${phrase}`,blocking:false}));
    }
  }

  for(const [from,to] of Object.entries(config.terminology??{})){
    for(const match of text.matchAll(new RegExp(`\\b${escape(from)}\\b`,'giu'))){
      const start=match.index??0;
      signals.push(signal(node,{ruleId:`terminology:${from}`,category:'terminology',severity:'minor',start,end:start+match[0].length,description:`Preferred term is "${to}"`,blocking:false}));
    }
  }

  for(const rule of config.blockingRules??[]){
    for(const match of text.matchAll(new RegExp(escape(rule.phrase),'giu'))){
      const start=match.index??0;
      signals.push(signal(node,{ruleId:`forbidden:${rule.phrase}`,category:'terminology',severity:'major',start,end:start+match[0].length,description:`Prohibited phrase: ${rule.phrase}`,blocking:true}));
    }
  }

  const parts=sentences(text);
  if(parts.length>=3){
    const openings=new Map<string,number>();
    for(const part of parts){
      const opening=part.text.split(/\s+/u)[0]?.toLowerCase().replace(/[^\p{L}]/gu,'')??'';
      if(opening.length>1)openings.set(opening,(openings.get(opening)??0)+1);
    }
    for(const [opening,count] of openings){
      if(count<3)continue;
      const first=parts.find(part=>part.text.toLowerCase().startsWith(opening))!;
      signals.push(signal(node,{ruleId:`repeated-opening:${opening}`,category:'ai_like_generic',severity:'minor',start:first.start,end:first.start+first.text.length,description:`${count} sentences begin with "${opening}"`,blocking:false,standalone:true}));
    }
    // Near-identical sentence lengths read as machine-uniform rhythm.
    const lengths=parts.map(part=>part.text.length);
    const mean=lengths.reduce((sum,value)=>sum+value,0)/lengths.length;
    const deviation=Math.sqrt(lengths.reduce((sum,value)=>sum+(value-mean)**2,0)/lengths.length);
    if(mean>40&&deviation/mean<0.12){
      signals.push(signal(node,{ruleId:'uniform-sentence-length',category:'ai_like_generic',severity:'nit',start:0,end:text.length,description:'Unusually uniform sentence lengths',blocking:false}));
    }
  }

  const words=text.split(/\s+/u).filter(Boolean).length;
  if(words>=20){
    for(const [pattern,ruleId,description] of [[SUPERLATIVES,'superlative-density','High density of superlatives'],[ADVERBS,'adverb-density','High density of -ly adverbs']] as const){
      const matches=[...text.matchAll(pattern)];
      if(matches.length/words>0.08&&matches.length>=3){
        const first=matches[0]!;
        signals.push(signal(node,{ruleId,category:'ai_like_generic',severity:'nit',start:first.index??0,end:(first.index??0)+first[0].length,description:`${description} (${matches.length} in ${words} words)`,blocking:false}));
      }
    }
  }

  const promotional=signals.filter(entry=>entry.ruleId.startsWith('promotional:'));
  const distinct=new Set(promotional.map(entry=>entry.ruleId));
  if(distinct.size>=3){
    const first=promotional.reduce((earliest,entry)=>entry.start<earliest.start?entry:earliest,promotional[0]!);
    signals.push(signal(node,{ruleId:'promotional-cluster',category:'ai_like_generic',severity:'minor',
      start:first.start,end:Math.min(text.length,promotional.reduce((last,entry)=>Math.max(last,entry.end),0)),
      description:`${distinct.size} low-information promotional phrases in one passage`,blocking:false,standalone:true}));
  }

  // A deterministic order keeps rule output reproducible for evaluation and ranking.
  return signals.sort((left,right)=>left.start-right.start||left.ruleId.localeCompare(right.ruleId,'en'));
}
