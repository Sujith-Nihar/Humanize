import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import { collector } from './core.js';
import type { ExtractionInput } from './core.js';
import type { ContentNode } from '@humanize/domain';

interface MdNode {type:string;value?:string;children?:MdNode[];position?:{start:{offset?:number};end:{offset?:number}};}
export function extractMarkdown(input:ExtractionInput) {
  const processor=input.filePath.endsWith('.mdx')?unified().use(remarkParse).use(remarkMdx):unified().use(remarkParse);
  const ast=processor.parse(input.source) as MdNode;
  const {nodes,emit}=collector(input,input.filePath.endsWith('.mdx')?'mdx':'markdown');
  const walk=(node:MdNode)=>{
    if(['code','mdxFlowExpression','mdxTextExpression','mdxjsEsm'].includes(node.type))return;
    if(node.type==='paragraph'||node.type==='heading'){
      let text='';const segments:ContentNode['segments']=[];
      const collect=(child:MdNode)=>{
        if(child.type==='text'&&child.value&&child.position?.start.offset!==undefined&&child.position.end.offset!==undefined){
          const start=child.position.start.offset,end=child.position.end.offset;
          segments.push({textStart:text.length,textEnd:text.length+child.value.length,sourceStart:start,sourceEnd:end,encoding:input.source.slice(start,end)===child.value?'identity':'composite'});text+=child.value;
        }else if(child.type==='inlineCode'&&child.value&&child.position?.start.offset!==undefined&&child.position.end.offset!==undefined){
          // Inline code is rendered to the reader, so dropping it would leave a hole in the
          // sentence under review. It is included as text and makes the node unsafe to patch.
          segments.push({textStart:text.length,textEnd:text.length+child.value.length,sourceStart:child.position.start.offset,sourceEnd:child.position.end.offset,encoding:'composite'});text+=child.value;
        }else if(['emphasis','strong','link','delete','paragraph'].includes(child.type))child.children?.forEach(collect);
      };
      node.children?.forEach(collect);
      const raw=input.source.slice(segments[0]?.sourceStart??0,segments.at(-1)?.sourceEnd??0);
      const tableMarkup=raw.split('\n').filter(Boolean).every(line=>line.trim().startsWith('|')&&line.trim().endsWith('|'));
      if(segments.length&&!tableMarkup){
        const first=segments[0]!,last=segments.at(-1)!;const simple=node.children?.length===1&&node.children[0]?.type==='text'&&segments[0]?.encoding==='identity';
        emit({start:first.sourceStart,end:last.sourceEnd,text,kind:node.type==='heading'?'heading':'documentation',sourceKind:simple?'markdown_text':'markdown_complex',safe:simple&&!text.includes('\n'),segments});
      }
      return;
    }
    node.children?.forEach(walk);
  };
  walk(ast);return nodes;
}
