import { parse } from '@babel/parser';
import babelTraverse from '@babel/traverse';
import type { NodePath, TraverseOptions } from '@babel/traverse';
import * as t from '@babel/types';
import { decodeHTML } from 'entities';
import { collector,trimmedSpan,visibleProps,kindFor } from './core.js';
import type { ExtractionInput } from './core.js';
type Traverser=(node:t.Node,options:TraverseOptions)=>void;
const traverse=((babelTraverse as unknown as {default:Traverser}).default??babelTraverse) as Traverser;

export function extractBabel(input:ExtractionInput) {
  const ast=parse(input.source,{sourceType:'unambiguous',plugins:[...( /\.[cm]?tsx?$/.test(input.filePath)?['typescript' as const]:[]),...(/\.[jt]sx$/.test(input.filePath)?['jsx' as const]:[])],errorRecovery:false});
  const {nodes,emit}=collector(input,'babel');
  const props=new Set([...visibleProps,...input.visibleProps??[]]);
  const calls=new Set(['toast','notify',...input.visibleCalls??[]]);
  const tag=(node:t.JSXElement):string=>t.isJSXIdentifier(node.openingElement.name)?node.openingElement.name.name:'Component';
  const hidden=(path:NodePath)=>!!path.findParent(p=>p.isJSXElement()&&['script','style','template'].includes(tag(p.node).toLowerCase()));
  const literal=(node:t.StringLiteral|t.TemplateLiteral,component:string,sourceKind='js_string')=>{
    if(node.start==null||node.end==null)return;
    const value=t.isStringLiteral(node)?node.value:node.expressions.length===0?node.quasis[0]?.value.cooked:null;
    if(value==null)return;
    const quote=input.source[node.start];
    emit({start:node.start+1,end:node.end-1,text:value,kind:kindFor(component),sourceKind,component,quoteStyle:quote==='"'?'double':quote==='`'?'template':'single',safe:!value.includes('\n')&&quote!=='`',encoding:'escape'});
  };
  traverse(ast,{
    JSXText(path){
      if(hidden(path)||path.node.start==null||path.node.end==null)return;
      const span=trimmedSpan(input.source,path.node.start,path.node.end);const parent=path.parentPath;
      const component=parent.isJSXElement()?tag(parent.node):'Fragment';
      emit({...span,text:decodeHTML(span.raw),kind:kindFor(component),sourceKind:'jsx_text',component,safe:!span.raw.includes('\n'),encoding:span.raw.includes('&')?'entity':'identity'});
    },
    JSXAttribute(path){
      if(hidden(path)||!t.isJSXIdentifier(path.node.name)||!props.has(path.node.name.name))return;
      const value=path.node.value;
      if(t.isStringLiteral(value)&&value.start!=null&&value.end!=null){
        const raw=input.source.slice(value.start+1,value.end-1);
        emit({start:value.start+1,end:value.end-1,text:decodeHTML(raw),kind:kindFor(path.node.name.name),sourceKind:'jsx_attribute',quoteStyle:input.source[value.start]==='"'?'double':'single',safe:true,encoding:raw.includes('&')?'entity':'identity'});
      } else if(t.isJSXExpressionContainer(value)&&(t.isStringLiteral(value.expression)||t.isTemplateLiteral(value.expression)))literal(value.expression,path.node.name.name);
    },
    JSXExpressionContainer(path){
      if(hidden(path)||path.parentPath.isJSXAttribute())return;
      const parent=path.findParent(p=>p.isJSXElement());const component=parent?.isJSXElement()?tag(parent.node):'Fragment';
      const expression=path.node.expression;
      if(t.isStringLiteral(expression)||t.isTemplateLiteral(expression))literal(expression,component);
      else if(t.isIdentifier(expression)){
        const binding=path.scope.getBinding(expression.name);
        if(binding?.constant&&binding.kind==='const'&&binding.path.isVariableDeclarator()){
          const init=binding.path.node.init;if(t.isStringLiteral(init)||t.isTemplateLiteral(init))literal(init,component);
        }
      }
    },
    CallExpression(path){
      if(!t.isIdentifier(path.node.callee)||!calls.has(path.node.callee.name))return;
      const first=path.node.arguments[0];if(t.isStringLiteral(first)||t.isTemplateLiteral(first))literal(first,'notification');
    },
  });
  return nodes;
}
