import { normalizeText } from '@humanize/shared';

// Words that carry no discriminating signal in product copy.
const STOPWORDS=new Set(['a','an','and','are','as','at','be','but','by','for','from','has','have','in','into','is','it','its','of','on','or','that','the','to','was','were','will','with','you','your']);
const MAX_TOKENS_PER_NODE=400;

export function tokenize(text:string):string[] {
  const tokens:string[]=[];
  for(const raw of normalizeText(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)){
    if(raw.length<2||raw.length>60||STOPWORDS.has(raw))continue;
    tokens.push(raw);
    if(tokens.length>=MAX_TOKENS_PER_NODE)break;
  }
  return tokens;
}

export function trigrams(text:string):Set<string> {
  const normalized=` ${normalizeText(text).toLowerCase()} `;
  const result=new Set<string>();
  for(let index=0;index+3<=normalized.length;index++)result.add(normalized.slice(index,index+3));
  return result;
}

/** Jaccard similarity over character trigrams; the lexical stand-in for pg_trgm. */
export function trigramSimilarity(left:string,right:string):number {
  const a=trigrams(left),b=trigrams(right);
  if(!a.size||!b.size)return 0;
  let shared=0;
  for(const gram of a)if(b.has(gram))shared++;
  return shared/(a.size+b.size-shared);
}

const K1=1.2,B=0.75;
/** Standard BM25 term weight, so scoring is explainable and deterministic. */
export function bm25(termFrequency:number,documentLength:number,averageLength:number,documentFrequency:number,total:number):number {
  if(!termFrequency)return 0;
  const idf=Math.log(1+(total-documentFrequency+0.5)/(documentFrequency+0.5));
  return idf*(termFrequency*(K1+1))/(termFrequency+K1*(1-B+B*(documentLength/(averageLength||1))));
}
