import { LIMITS } from '@humanize/domain';
import { extractBabel } from './babel.js';
import { extractHtml } from './html.js';
import { extractLocale,isLocaleSource } from './locale.js';
import { extractMarkdown } from './markdown.js';
import { extractVue } from './vue.js';
import { extractSvelte } from './svelte.js';
import { extractCss } from './css.js';
import type { ExtractionInput,ExtractionResult } from './core.js';
export type { ExtractionInput,ExtractionResult } from './core.js';
export { placeholders,EXTRACTOR_VERSION } from './core.js';
export { extractHtml } from './html.js';
export { extractLocale,isLocaleSource } from './locale.js';
export { extractVue } from './vue.js';
export { extractSvelte } from './svelte.js';
export { extractCss } from './css.js';

export function extract(input:ExtractionInput):ExtractionResult {
  if(Buffer.byteLength(input.source)>LIMITS.fileBytes)return {nodes:[],diagnostics:[{code:'FILE_TOO_LARGE',filePath:input.filePath}]};
  const capped=(result:ExtractionResult):ExtractionResult=>result.nodes.length>=LIMITS.nodesPerFile
    // Reported rather than silent: a truncated file is partially reviewed, and the caller
    // must be able to see that rather than assume full coverage.
    ?{nodes:result.nodes,diagnostics:[...result.diagnostics,{code:'NODE_LIMIT_REACHED',filePath:input.filePath}]}
    :result;
  try {
    if(/\.[cm]?[jt]sx?$/.test(input.filePath))return capped({nodes:extractBabel(input),diagnostics:[]});
    if(/\.mdx?$/.test(input.filePath))return capped({nodes:extractMarkdown(input),diagnostics:[]});
    if(/\.html?$/.test(input.filePath))return capped({nodes:extractHtml(input),diagnostics:[]});
    if(/\.vue$/.test(input.filePath))return capped({nodes:extractVue(input),diagnostics:[]});
    if(/\.svelte$/.test(input.filePath))return capped({nodes:extractSvelte(input),diagnostics:[]});
    if(/\.css$/.test(input.filePath))return capped({nodes:extractCss(input),diagnostics:[]});
    if(/\.(json|ya?ml)$/.test(input.filePath)){
      // Only a recognised locale resource is reviewed; arbitrary JSON is configuration.
      return isLocaleSource(input.filePath,input.localeSource)
        ? capped({nodes:extractLocale(input),diagnostics:[]})
        : {nodes:[],diagnostics:[{code:'NOT_A_LOCALE_SOURCE',filePath:input.filePath}]};
    }
    return {nodes:[],diagnostics:[{code:'UNSUPPORTED_FORMAT',filePath:input.filePath}]};
  }catch{return {nodes:[],diagnostics:[{code:'PARSE_FAILURE',filePath:input.filePath}]};}
}
