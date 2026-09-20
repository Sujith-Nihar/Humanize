import { parseDocument,isMap,isPair,isScalar,isSeq } from 'yaml';
import { collector } from './core.js';
import type { ExtractionInput } from './core.js';

// Conventional homes for translation resources, per the specification.
const LOCALE_PATH=/(^|\/)(locales?|i18n|translations?|messages|lang)(\/|\.)/i;
const LOCALE_FILE=/(^|\/)[a-z]{2}(?:[-_][A-Za-z]{2,4})?\.(json|ya?ml)$/;
// Keys whose values are configuration or identifiers, never prose a user reads.
const MACHINE_KEY=/(^|[._-])(id|key|url|uri|href|path|route|endpoint|type|version|locale|lang|code|format|icon|color|class|name_?space|schema|ref|sha|hash|digest|token|secret|slug)$/i;
const MACHINE_VALUE=/^(?:https?:\/\/|\/|#|[a-z0-9_-]+\.[a-z]{2,}$|[0-9a-f]{8}-|\{\{?[^}]*\}?\}$)/i;

/** A file is a locale resource when its path says so, or the caller configured it as one. */
export function isLocaleSource(filePath:string,configured?:boolean):boolean {
  return configured===true||LOCALE_PATH.test(filePath)||LOCALE_FILE.test(filePath);
}

const readable=(key:string,value:string):boolean=>{
  if(!value.trim()||value.length>2000)return false;
  if(MACHINE_KEY.test(key.split('.').pop()??key))return false;
  if(MACHINE_VALUE.test(value.trim()))return false;
  // A single unspaced token that reads as a digest or identifier is not prose.
  const trimmed=value.trim();
  if(!trimmed.includes(' ')&&(/^[0-9a-f]{8,}$/i.test(trimmed)||/^[A-Za-z0-9_-]{16,}$/.test(trimmed)))return false;
  // A value with no letters is a symbol or a number, not prose.
  return /\p{L}/u.test(value);
};

/**
 * Extracts translated strings from JSON and YAML locale resources. Values are the content a
 * user reads; keys are context and are never reviewed as prose. The specification is explicit
 * that not every JSON string in a repository is reviewable, so a file is only treated as a
 * locale resource when its path or configuration says it is.
 */
export function extractLocale(input:ExtractionInput) {
  const {nodes,emit}=collector(input,input.filePath.endsWith('.json')?'json-locale':'yaml-locale');
  const document=parseDocument(input.source,{keepSourceTokens:true});
  if(document.errors.length)return nodes;

  const walk=(value:unknown,keyPath:string[]):void=>{
    if(isMap(value)){
      for(const item of value.items)if(isPair(item)){
        const key=isScalar(item.key)?String(item.key.value):'';
        walk(item.value,[...keyPath,key]);
      }
      return;
    }
    if(isSeq(value)){value.items.forEach((item,index)=>{walk(item,[...keyPath,String(index)]);});return;}
    if(!isScalar(value)||typeof value.value!=='string')return;
    const key=keyPath.join('.');
    if(!readable(key,value.value))return;
    const range=value.range;
    if(!range)return;
    const [start,end]=range;
    const raw=input.source.slice(start,end);
    const quoted=raw.startsWith('"')||raw.startsWith("'");
    emit({
      // The span covers the value only; a suggestion re-encodes inside the existing quotes.
      start:quoted?start+1:start,end:quoted?end-1:end,text:value.value,
      kind:'label',sourceKind:`locale:${key}`,structuralPath:key,
      quoteStyle:raw.startsWith("'")?'single':quoted?'double':'none',
      // An escape in the raw source means the literal and the value differ.
      safe:!/\\/.test(raw),encoding:/\\/.test(raw)?'escape':'identity',
      confidence:0.95,
    });
  };
  walk(document.contents,[]);
  return nodes;
}
