import { ContentNodeSchema, LIMITS } from '@humanize/domain';
import type { ContentNode } from '@humanize/domain';
import { fingerprint, lineAt, normalizeText } from '@humanize/shared';

export interface ExtractionInput { repositoryId:string;commitSha:string;blobSha:string;filePath:string;source:string;configHash?:string;visibleProps?:string[];visibleCalls?:string[];locale?:string;localeSource?:boolean; }
export interface ExtractionResult { nodes:ContentNode[]; diagnostics:Array<{code:string;filePath:string}>; }
export interface Emission {start:number;end:number;text:string;kind?:ContentNode['kind'];sourceKind:string;quoteStyle?:ContentNode['quoteStyle'];safe?:boolean;confidence?:number;component?:string;structuralPath?:string;encoding?:'identity'|'entity'|'escape'|'composite';segments?:ContentNode['segments'];}
export const EXTRACTOR_VERSION='1.0.0';
export const visibleProps=new Set(['title','alt','placeholder','aria-label','aria-description','label','description','helperText','caption','tooltip']);
export function placeholders(text:string):string[] {
  // ICU complex expressions remain comment-only. Preserve exact placeholders including format specifications.
  return [...text.matchAll(/\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[^{}]+\}|%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]|%%/g)].map(match=>match[0]);
}
export function kindFor(name:string):ContentNode['kind'] {
  if(/^h[1-6]$/i.test(name))return 'heading';
  if(/button/i.test(name))return 'button';
  if(name==='a')return 'link';
  if(name==='placeholder')return 'placeholder';
  if(name==='alt'||name.startsWith('aria-'))return 'accessibility';
  if(name==='label')return 'label';
  return 'paragraph';
}
export function collector(input:ExtractionInput,parser:string) {
  const nodes:ContentNode[]=[];
  const seen=new Set<string>();
  const emit=(value:Emission)=>{
    // A single file with tens of thousands of visible strings is a resource problem, not a
    // review: extraction stops at the cap so one file cannot consume a job's time budget.
    if(nodes.length>=LIMITS.nodesPerFile)return;
    if(!value.text.trim()||value.text.length>LIMITS.nodeChars||value.start<0||value.end>input.source.length||value.end<=value.start)return;
    const unique=`${value.start}:${value.end}`;if(seen.has(unique))return;seen.add(unique);
    const configHash=input.configHash??fingerprint({props:input.visibleProps??[],calls:input.visibleCalls??[],localeSource:input.localeSource??false});
    const structural=value.structuralPath??`${value.sourceKind}:${nodes.length}`;
    nodes.push(ContentNodeSchema.parse({
      id:fingerprint([input.repositoryId,input.commitSha,input.filePath,input.blobSha,parser,EXTRACTOR_VERSION,configHash,value.start,value.end]),
      repositoryId:input.repositoryId,commitSha:input.commitSha,filePath:input.filePath,blobSha:input.blobSha,
      parser,parserVersion:EXTRACTOR_VERSION,startOffset:value.start,endOffset:value.end,
      startLine:lineAt(input.source,value.start),endLine:lineAt(input.source,value.end-1),text:value.text,normalizedText:normalizeText(value.text),
      kind:value.kind??'paragraph',sourceKind:value.sourceKind,dynamic:false,visibilityConfidence:value.confidence??1,
      placeholders:placeholders(value.text),stableKey:fingerprint([input.repositoryId,input.filePath,parser,structural]),
      mappingVersion:1,segments:value.segments??[{textStart:0,textEnd:value.text.length,sourceStart:value.start,sourceEnd:value.end,encoding:value.encoding??'identity'}],
      extractionConfigHash:configHash,suggestionSafe:value.safe??false,
      ...(value.quoteStyle?{quoteStyle:value.quoteStyle}:{}),...(value.component?{component:value.component}:{}),
      structuralPath:structural,...(input.locale?{locale:input.locale}:{}),
    }));
  };
  return {nodes,emit};
}
export function trimmedSpan(source:string,start:number,end:number):{start:number;end:number;raw:string} {
  const raw=source.slice(start,end);const leading=raw.length-raw.trimStart().length;const trailing=raw.length-raw.trimEnd().length;
  return {start:start+leading,end:end-trailing,raw:raw.trim()};
}
