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
  /**
   * The node text with the construction removed, where removal is unambiguous. Only offered
   * for constructions whose fix is a deletion; rewriting prose is the model's job, not a
   * regular expression's.
   */
  replacement?:string;
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
/**
 * Formulaic sentence constructions, as distinct from formulaic vocabulary.
 *
 * Writing can be built entirely from specific, product-accurate words and still read as
 * machine-made, because the architecture is a template: define the thing by what it is not,
 * set a scene nobody asked for, or restate the heading after a dash. A phrase list cannot
 * reach any of that.
 *
 * Each pattern is narrow on purpose. An em dash, a contrast and a negation are ordinary tools
 * of good writing, so these match the whole construction and never the punctuation alone — a
 * rule that fired on every em dash would be worse than no rule at all.
 */
interface Construction {
  ruleId:string;
  pattern:RegExp;
  description:string;
  /** Returns the node text with the construction removed, or undefined when no safe deletion exists. */
  rewrite?:(text:string)=>string|undefined;
}
const STRAWMAN_ASIDE=/\s*[—–]\s*not\s+(?:\w+ly\s+)?\w+(?:ed|ing)\b\s*[—–]\s*/giu;
const CONSTRUCTIONS:readonly Construction[]=[
  // "It's not just music — it's science": asserts significance instead of stating any.
  {ruleId:'construction:negation-reframe',
   pattern:/\bnot\s+(?:just|merely|simply|only)\b[^.!?]{0,80}?[—–]\s*(?:it'?s|its|they'?re|we'?re|you'?re|that'?s)\b/giu,
   description:'Defines the subject by what it is not, rather than stating what it is'},
  // "— not randomly generated —": contrast against a strawman nobody proposed. Where the
  // strawman sits between two dashes it is a clean aside, so deleting it is unambiguous.
  {ruleId:'construction:strawman-contrast',
   pattern:/[—–]\s*not\s+(?:\w+ly\s+)?\w+(?:ed|ing)\b/giu,
   // The only deletion offered anywhere: the removed span is a NEGATION of the claim beside
   // it, so dropping it leaves every positive statement intact. "intentionally designed —
   // not randomly generated — to support X" still asserts intentional design.
   description:'Contrast drawn against an alternative nobody proposed',
   rewrite:text=>{
     const removed=text.replace(STRAWMAN_ASIDE,' ').replace(/\s{2,}/gu,' ').trim();
     return removed!==text&&removed.length>0?removed:undefined;
   }},
  // "no guesswork, just sound engineered for…": the contrast carries the emphasis.
  {ruleId:'construction:no-x-just-y',
   pattern:/\bno\s+\w+,\s*just\s+\w+/giu,
   description:'No-X-just-Y construction, where the contrast substitutes for the claim'},
  // Scene-setting openers that say nothing about the subject.
  {ruleId:'construction:scene-setting-opener',
   pattern:/^[\s"'“]*(?:in a world (?:of|where)\b|imagine a world\b|gone are the days\b|say goodbye to\b)/giu,
   description:'Scene-setting opener that carries no information about the subject'},
  // "Sound — Designed for the Mind": a tagline restating the heading, so dropping it is safe.
  {ruleId:'construction:tagline-appositive',
   pattern:/[—–]\s*(?:designed|built|engineered|crafted|tuned|made|optimi[sz]ed|powered|purpose-built)\s+(?:for|by|to)\b/giu,
   // Deliberately offers no rewrite. Deleting the appositive removes a claim the author
   // made ("Designed for the Mind" says what the product is for), and an edit that loses
   // information is not an improvement. Rewriting this needs a model, or a person.
   description:'Em-dash tagline restating the heading rather than adding to it'},
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

/**
 * Independent families of evidence. Two signals from the same family are one observation, not
 * two: counting occurrences instead of families would let a single habit corroborate itself.
 * Aggregate families that ADR-037 already lets stand alone are excluded, since they publish on
 * their own and must not also inflate a composite.
 */
const FAMILY_OF=(ruleId:string):string|null=>{
  if(ruleId.startsWith('construction:'))return 'formulaic construction';
  if(ruleId.startsWith('punctuation:'))return 'punctuation profile';
  if(ruleId.startsWith('promotional:'))return 'low-information vocabulary';
  if(ruleId.startsWith('padding:'))return 'padded phrasing';
  if(ruleId==='uniform-sentence-length')return 'uniform sentence rhythm';
  if(ruleId==='superlative-density'||ruleId==='adverb-density')return 'modifier density';
  return null;
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

  // Formulaic constructions: the architecture of a sentence rather than its vocabulary. The
  // phrase lists above cannot see these, because the words themselves are ordinary and often
  // product-specific; what is formulaic is the shape. Each pattern is deliberately narrow,
  // since em dashes and contrast are also the tools of good writing.
  for(const construction of CONSTRUCTIONS){
    for(const match of text.matchAll(construction.pattern)){
      const start=match.index??0;
      const rewritten=construction.rewrite?.(text);
      // Not standalone on its own. "It's not X, it's Y" appears in Shakespeare and the Bible;
      // an em-dash aside is ordinary craft. A construction becomes publishable only when a
      // second, independent family corroborates it — see the composite signal below.
      signals.push(signal(node,{ruleId:construction.ruleId,category:'ai_like_generic',severity:'minor',
        start,end:start+match[0].length,description:construction.description,blocking:false,
        ...(rewritten!==undefined&&rewritten!==text?{replacement:rewritten}:{})}));
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

  // Punctuation profile. Editors report the em dash as the most visible marker, and the same
  // reporting is explicit that it cannot carry a judgement alone: models learned it from
  // well-edited human prose. It is therefore evidence only, and never a finding.
  const emDashes=[...text.matchAll(/[—–]/gu)];
  if(emDashes.length>0){
    const words=text.split(/\s+/u).filter(Boolean).length;
    const dense=emDashes.length>=2||(words>0&&words<=14&&emDashes.length>=1);
    if(dense){
      const first=emDashes[0]!;
      signals.push(signal(node,{ruleId:'punctuation:em-dash',category:'ai_like_generic',severity:'nit',
        start:first.index??0,end:(first.index??0)+1,
        description:`${emDashes.length} em dash${emDashes.length===1?'':'es'} in ${words} words`,blocking:false}));
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

  /**
   * Corroboration. No single marker is trustworthy: the em dash was learned from well-edited
   * human prose, and "not X, it's Y" predates the machines by several centuries. The research
   * consensus is that combined feature sets are far stronger than any one signal, so a finding
   * is published only where independent families agree on the same passage.
   *
   * Families are counted, not occurrences: three em dashes remain one observation.
   */
  const families=new Set(signals.map(entry=>FAMILY_OF(entry.ruleId)).filter((name):name is string=>name!==null));
  if(families.size>=2){
    const corroborating=signals.filter(entry=>FAMILY_OF(entry.ruleId)!==null);
    const earliest=corroborating.reduce((first,entry)=>entry.start<first.start?entry:first,corroborating[0]!);
    // The finding carries the strongest member's replacement, where one exists, so a proven
    // deletion is still offered; the composite itself never invents a rewrite.
    const rewritable=corroborating.find(entry=>entry.replacement!==undefined);
    signals.push(signal(node,{ruleId:'ai-style:corroborated',category:'ai_like_generic',severity:'minor',
      start:earliest.start,end:earliest.end,matchedText:earliest.matchedText,
      description:`${[...families].sort().join(' and ')} together in one passage: ${corroborating.map(entry=>entry.description).join('; ')}`,
      blocking:false,standalone:true,...(rewritable?.replacement!==undefined?{replacement:rewritable.replacement}:{})}));
  }

  // A deterministic order keeps rule output reproducible for evaluation and ranking.
  return signals.sort((left,right)=>left.start-right.start||left.ruleId.localeCompare(right.ruleId,'en'));
}
