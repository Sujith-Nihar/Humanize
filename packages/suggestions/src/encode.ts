import type { ContentNode } from '@humanize/domain';

export type EncodingFailure='UNSUPPORTED_SOURCE'|'UNSAFE_NODE'|'CONTROL_CHARACTER'|'MULTILINE_NOT_SUPPORTED'|'MARKUP_IN_REPLACEMENT';

export interface EncodedReplacement { source:string; encoded:string; }
export type EncodeResult={ok:true;value:EncodedReplacement}|{ok:false;failure:EncodingFailure};

// A replacement is prose. Anything that could open a tag, an expression or an escape is a
// structural change dressed as text, and must never be encoded into the file.
const MARKUP=/[<>{}]|\\\\|\$\{/;
// Control characters are invisible in a diff and can corrupt a file; detected by code
// point rather than a literal regex so the source stays free of control characters.
const isControl=(value:string):boolean=>[...value].some(character=>{
  const code=character.codePointAt(0)??0;
  return (code<0x20&&code!==0x09&&code!==0x0a&&code!==0x0d)||code===0x7f;
});

function jsString(value:string,quote:'single'|'double'|'template'):string {
  const escaped=value
    .replace(/\\/g,'\\\\')
    .replace(/\n/g,'\\n')
    .replace(/\r/g,'\\r')
    .replace(/\t/g,'\\t');
  if(quote==='single')return escaped.replace(/'/g,"\\'");
  if(quote==='double')return escaped.replace(/"/g,'\\"');
  return escaped.replace(/`/g,'\\`').replace(/\$\{/g,'\\${');
}

const HTML_TEXT_ENTITIES:[RegExp,string][]=[[/&/g,'&amp;'],[/</g,'&lt;'],[/>/g,'&gt;']];

/**
 * Produces the exact characters that must replace a node's source span, in the encoding that
 * span requires. A replacement is refused rather than guessed: an unsupported source kind, a
 * node the extractor already marked unsafe, control characters, or prose that carries markup
 * all fall back to comment-only, because a wrong encoding corrupts a customer's file.
 */
export function encodeReplacement(node:ContentNode,replacement:string):EncodeResult {
  if(!node.suggestionSafe)return {ok:false,failure:'UNSAFE_NODE'};
  if(isControl(replacement))return {ok:false,failure:'CONTROL_CHARACTER'};
  if(node.startLine!==node.endLine&&replacement.includes('\n'))return {ok:false,failure:'MULTILINE_NOT_SUPPORTED'};

  const kind=node.sourceKind;

  if(kind==='jsx_text'||kind.startsWith('html_text')||kind==='markdown'||kind==='mdx'||node.parser==='markdown'||node.parser==='mdx'){
    // Text position: a brace opens a JSX expression and an angle bracket opens an element.
    if(MARKUP.test(replacement))return {ok:false,failure:'MARKUP_IN_REPLACEMENT'};
    const encoded=kind.startsWith('html_text')
      ? HTML_TEXT_ENTITIES.reduce((value,[pattern,entity])=>value.replace(pattern,entity),replacement)
      : replacement;
    return {ok:true,value:{source:node.text,encoded}};
  }

  if(kind.startsWith('html_attribute')){
    if(replacement.includes('<')||replacement.includes('>'))return {ok:false,failure:'MARKUP_IN_REPLACEMENT'};
    // The span sits inside the existing quotes, so only that quote needs escaping.
    const quote=node.quoteStyle==='single'?"'":'"';
    const entity=quote==='"'?'&quot;':'&#39;';
    return {ok:true,value:{source:node.text,encoded:replacement.replace(/&/g,'&amp;').split(quote).join(entity)}};
  }

  if(kind.startsWith('locale:')||kind==='json'||kind==='yaml'){
    if(node.quoteStyle==='none'){
      // A bare YAML scalar changes meaning if it starts with an indicator character.
      if(/^[-?:,[\]{}#&*!|>'"%@`]/.test(replacement)||replacement.includes(': ')||replacement.endsWith(':'))return {ok:false,failure:'MARKUP_IN_REPLACEMENT'};
      return {ok:true,value:{source:node.text,encoded:replacement}};
    }
    const quote=node.quoteStyle==='single'?'single':'double';
    return {ok:true,value:{source:node.text,encoded:jsString(replacement,quote)}};
  }

  if(kind.startsWith('js_string')||kind.startsWith('jsx_attribute')||kind.startsWith('call:')){
    const quote=node.quoteStyle==='template'?'template':node.quoteStyle==='single'?'single':'double';
    return {ok:true,value:{source:node.text,encoded:jsString(replacement,quote)}};
  }

  return {ok:false,failure:'UNSUPPORTED_SOURCE'};
}

/** Applies an encoded replacement to the file in memory; nothing is written to disk. */
export function applyReplacement(source:string,node:ContentNode,encoded:string):string {
  return source.slice(0,node.startOffset)+encoded+source.slice(node.endOffset);
}
