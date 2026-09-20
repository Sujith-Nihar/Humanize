import postcss from 'postcss';
import { collector } from './core.js';
import type { ExtractionInput } from './core.js';

// Values that render nothing a reader can understand as words.
const NON_TEXT=/^(?:none|normal|open-quote|close-quote|no-open-quote|no-close-quote|inherit|initial|unset|revert|counter\(|counters\(|attr\(|url\(|var\(|\\)/i;

/**
 * Extracts static `content` values from CSS pseudo-elements. This text is rendered to users
 * but is invisible to assistive technology and to translation, so it is extracted with lower
 * visibility confidence and reviewed conservatively. Dynamic values built from `attr()`,
 * `counter()` or a custom property are not prose and are skipped.
 */
export function extractCss(input:ExtractionInput) {
  const {nodes,emit}=collector(input,'css');
  let root:postcss.Root;
  try{root=postcss.parse(input.source,{from:input.filePath});}catch{return nodes;}

  root.walkDecls('content',declaration=>{
    const selector=(declaration.parent as postcss.Rule|undefined)?.selector??'';
    // Only pseudo-element content is rendered as visible text.
    if(!/::?(?:before|after)\b/i.test(selector))return;
    const value=declaration.value.trim();
    if(NON_TEXT.test(value))return;
    const quote=value.startsWith('"')?'"':value.startsWith("'")?"'":'';
    if(!quote||!value.endsWith(quote)||value.length<2)return;
    const text=value.slice(1,-1);
    if(!text.trim()||!/\p{L}/u.test(text))return;

    const declarationStart=declaration.source?.start?.offset;
    if(declarationStart===undefined)return;
    const raw=input.source.slice(declarationStart,declaration.source?.end?.offset??declarationStart+declaration.toString().length);
    const valueOffset=raw.indexOf(value);
    if(valueOffset<0)return;
    const start=declarationStart+valueOffset+1;
    emit({
      start,end:start+text.length,text,kind:'css_generated',
      sourceKind:`css_content:${selector.trim()}`,structuralPath:`${selector.trim()}::content`,
      quoteStyle:quote==='"'?'double':'single',
      // A CSS escape means the source and the rendered text differ.
      safe:!text.includes('\\'),encoding:text.includes('\\')?'escape':'identity',
      // Generated content is real but often poor for accessibility; review it conservatively.
      confidence:0.85,
    });
  });
  return nodes;
}
