import { parse } from 'svelte/compiler';
import { collector,kindFor,trimmedSpan } from './core.js';
import type { ExtractionInput } from './core.js';

interface SvelteNode {
  type:string; name?:string; data?:string; raw?:string; start?:number; end?:number;
  attributes?:SvelteNode[]; value?:SvelteNode[]|boolean; children?:SvelteNode[];
  fragment?:{nodes:SvelteNode[]};
  nodes?:SvelteNode[];
}
const SKIPPED=new Set(['script','style','pre','code']);
const VISIBLE_ATTRIBUTES=new Set(['alt','title','placeholder','aria-label','aria-description','label','summary']);

/**
 * Extracts static template text from a Svelte component using the official compiler. An
 * attribute or text containing an expression is marked dynamic rather than reviewed as prose,
 * because its rendered value is only known at runtime and this product never executes
 * customer code to find out.
 */
export function extractSvelte(input:ExtractionInput) {
  const {nodes,emit}=collector(input,'svelte');
  let ast:SvelteNode;
  try{
    const parsed=parse(input.source,{modern:true}) as unknown as {fragment:{nodes:SvelteNode[]}};
    ast={type:'Root',fragment:parsed.fragment};
  }catch{return nodes;}

  const childrenOf=(node:SvelteNode):SvelteNode[]=>node.fragment?.nodes??node.nodes??node.children??[];

  const walk=(node:SvelteNode,ancestry:string[]):void=>{
    const name=node.name?.toLowerCase();
    if(node.type==='RegularElement'&&name&&SKIPPED.has(name))return;
    const path=name?[...ancestry,name]:ancestry;

    if(node.type==='Text'&&node.start!==undefined&&node.end!==undefined){
      const span=trimmedSpan(input.source,node.start,node.end);
      if(span.raw){
        const parent=ancestry.at(-1)??'template';
        emit({start:span.start,end:span.end,text:(node.data??span.raw).trim(),kind:kindFor(parent),
          sourceKind:`svelte_text:${parent}`,structuralPath:`${path.join('>')}#text`,safe:true});
      }
    }

    for(const attribute of node.attributes??[]){
      const attributeName=attribute.name?.toLowerCase();
      if(attribute.type!=='Attribute'||!attributeName||!VISIBLE_ATTRIBUTES.has(attributeName))continue;
      const parts=Array.isArray(attribute.value)?attribute.value:[];
      // A single Text part is a literal; anything else interpolates an expression.
      if(parts.length!==1||parts[0]?.type!=='Text')continue;
      const part=parts[0];
      if(part.start===undefined||part.end===undefined)continue;
      const text=(part.data??'').trim();
      if(!text)continue;
      const before=input.source[part.start-1];
      emit({start:part.start,end:part.end,text,kind:kindFor(attributeName),
        sourceKind:`svelte_attribute:${attributeName}`,structuralPath:`${path.join('>')}@${attributeName}`,
        quoteStyle:before==='"'?'double':before==="'"?'single':'none',safe:true});
    }

    for(const child of childrenOf(node))walk(child,path);
  };

  walk(ast,[]);
  return nodes;
}
