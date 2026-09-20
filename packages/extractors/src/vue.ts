import { parse } from '@vue/compiler-sfc';
import { collector,kindFor,trimmedSpan } from './core.js';
import type { ExtractionInput } from './core.js';

interface TemplateNode {
  type:number; tag?:string; content?:string|{type:number;content?:string};
  props?:{type:number;name:string;value?:{content:string;loc?:{start:{offset:number};end:{offset:number}}};loc?:{start:{offset:number};end:{offset:number}}}[];
  children?:TemplateNode[];
  loc?:{start:{offset:number};end:{offset:number}};
}
// Node types from the Vue compiler AST.
const ELEMENT=1,TEXT=2,INTERPOLATION=5,ATTRIBUTE=6;
const SKIPPED=new Set(['script','style','template','pre','code']);
const VISIBLE_ATTRIBUTES=new Set(['alt','title','placeholder','aria-label','aria-description','label','summary']);

/**
 * Extracts static template text from a Vue single-file component. Offsets come from the
 * compiler and are already relative to the original file, so a finding maps to the real
 * source rather than to an extracted block. Interpolations are recorded as dynamic and their
 * expressions are never evaluated: resolving them would mean executing customer code.
 */
export function extractVue(input:ExtractionInput) {
  const {descriptor,errors}=parse(input.source,{filename:input.filePath});
  const {nodes,emit}=collector(input,'vue');
  if(errors.length||!descriptor.template?.ast)return nodes;

  const walk=(node:TemplateNode,ancestry:string[]):void=>{
    const tag=node.tag?.toLowerCase();
    if(tag&&SKIPPED.has(tag))return;
    const path=tag?[...ancestry,tag]:ancestry;

    if(node.type===TEXT&&node.loc&&typeof node.content==='string'){
      const span=trimmedSpan(input.source,node.loc.start.offset,node.loc.end.offset);
      if(span.raw){
        const parent=ancestry.at(-1)??'template';
        emit({start:span.start,end:span.end,text:span.raw,kind:kindFor(parent),
          sourceKind:`vue_text:${parent}`,structuralPath:`${path.join('>')}#text`,safe:true});
      }
    }

    for(const prop of node.props??[]){
      // A directive such as :title or v-bind carries an expression, not prose.
      if(prop.type!==ATTRIBUTE||!VISIBLE_ATTRIBUTES.has(prop.name.toLowerCase()))continue;
      const value=prop.value;
      if(!value?.loc||!value.content.trim())continue;
      const raw=input.source.slice(value.loc.start.offset,value.loc.end.offset);
      const quote=raw.startsWith('"')?'double':raw.startsWith("'")?'single':'none';
      const start=quote==='none'?value.loc.start.offset:value.loc.start.offset+1;
      const end=quote==='none'?value.loc.end.offset:value.loc.end.offset-1;
      if(end<=start)continue;
      emit({start,end,text:value.content.trim(),kind:kindFor(prop.name),
        sourceKind:`vue_attribute:${prop.name}`,structuralPath:`${path.join('>')}@${prop.name}`,quoteStyle:quote,safe:true});
    }

    for(const child of node.children??[])walk(child,path);
  };

  walk(descriptor.template.ast as unknown as TemplateNode,[]);
  return nodes;
}
export const VUE_INTERPOLATION=INTERPOLATION;
export const VUE_ELEMENT=ELEMENT;
