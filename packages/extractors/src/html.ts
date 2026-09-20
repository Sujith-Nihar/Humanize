import { parseFragment } from 'parse5';
import { collector,kindFor,trimmedSpan } from './core.js';
import type { ExtractionInput } from './core.js';

interface Location {startOffset:number;endOffset:number;}
interface Parse5Node {
  nodeName:string; tagName?:string; value?:string;
  attrs?:{name:string;value:string}[];
  childNodes?:Parse5Node[];
  sourceCodeLocation?:Location&{attrs?:Record<string,Location>;startTag?:Location;endTag?:Location};
}

// Rendered by the browser but never read as prose, or carrying code rather than words.
const SKIPPED_ELEMENTS=new Set(['script','style','template','noscript','svg','code','pre','iframe','object']);
// Attributes a user can actually read, directly or through assistive technology.
const VISIBLE_ATTRIBUTES=new Set(['alt','title','placeholder','aria-label','aria-description','aria-placeholder','aria-roledescription','label','summary']);
// Machine-facing values that look like text but are never read as prose.
const MACHINE_ATTRIBUTES=new Set(['href','src','id','class','name','type','rel','role','target','style','srcset','content','value','for','action','method','data','integrity','crossorigin']);

const ENTITY=/&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/**
 * Extracts what a reader sees in an HTML document: rendered text and the attributes assistive
 * technology speaks aloud. Script, style and template contents are never prose, and machine
 * attributes such as href or class are excluded however wordy their values look.
 *
 * Text containing an HTML entity is marked unsafe for one-click replacement, because the raw
 * source and the rendered text differ and a naive replacement would corrupt the encoding.
 */
export function extractHtml(input:ExtractionInput) {
  const document=parseFragment(input.source,{sourceCodeLocationInfo:true}) as unknown as Parse5Node;
  const {nodes,emit}=collector(input,'html');

  const walk=(node:Parse5Node,ancestry:string[]):void=>{
    const tag=node.tagName?.toLowerCase();
    if(tag&&SKIPPED_ELEMENTS.has(tag))return;
    const path=tag?[...ancestry,tag]:ancestry;

    if(node.nodeName==='#text'&&node.sourceCodeLocation&&node.value!==undefined){
      const span=trimmedSpan(input.source,node.sourceCodeLocation.startOffset,node.sourceCodeLocation.endOffset);
      if(span.raw){
        const parent=ancestry.at(-1)??'body';
        emit({
          start:span.start,end:span.end,text:node.value.trim(),
          kind:kindFor(parent),sourceKind:`html_text:${parent}`,structuralPath:`${path.join('>')}#text`,
          // Entity-bearing text cannot be replaced verbatim without re-encoding.
          safe:!ENTITY.test(span.raw),encoding:ENTITY.test(span.raw)?'entity':'identity',
          confidence:parent==='title'?0.9:1,
        });
      }
    }

    for(const attribute of node.attrs??[]){
      const name=attribute.name.toLowerCase();
      if(MACHINE_ATTRIBUTES.has(name)||!VISIBLE_ATTRIBUTES.has(name))continue;
      const location=node.sourceCodeLocation?.attrs?.[name];
      if(!location||!attribute.value.trim())continue;
      const raw=input.source.slice(location.startOffset,location.endOffset);
      const quote=raw.includes('"')?'"':raw.includes("'")?"'":'';
      const quoteStyle=quote==='"'?'double':quote==="'"?'single':'none';
      // The span must be located from the quotes, not by searching for the decoded value:
      // an entity-bearing value never appears verbatim in the source, and searching for it
      // would silently drop the attribute instead of reviewing it.
      const opening=quote?raw.indexOf(quote):raw.indexOf('=');
      const closing=quote?raw.lastIndexOf(quote):raw.length;
      if(opening<0||closing<=opening)continue;
      const valueStart=location.startOffset+opening+1;
      const valueEnd=location.startOffset+closing;
      if(valueEnd<=valueStart)continue;
      // A value whose source differs from its decoded text cannot be replaced verbatim.
      const encoded=input.source.slice(valueStart,valueEnd)!==attribute.value;
      emit({
        start:valueStart,end:valueEnd,text:attribute.value.trim(),
        kind:kindFor(name),sourceKind:`html_attribute:${name}`,structuralPath:`${path.join('>')}@${name}`,
        quoteStyle,safe:!encoded,encoding:encoded?'entity':'identity',
        confidence:name==='alt'||name.startsWith('aria-')?1:0.95,
      });
    }

    for(const child of node.childNodes??[])walk(child,path);
  };

  walk(document,[]);
  return nodes;
}
