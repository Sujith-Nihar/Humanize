import { expect,it } from 'vitest';
import { extract } from '@humanize/extractors';
import { buildSuggestion,validatePlaceholders } from './src/index.js';
import type { ContentNode } from '@humanize/domain';

const headSha='b'.repeat(40);
const nodeFrom=(source:string,filePath:string,match:(node:ContentNode)=>boolean):ContentNode=>{
  const found=extract({repositoryId:'repo',commitSha:headSha,blobSha:'d'.repeat(40),filePath,source}).nodes.find(match);
  if(!found)throw Error(`no node matched in ${filePath}`);
  return found;
};
const build=(source:string,filePath:string,replacement:string,match:(node:ContentNode)=>boolean=()=>true)=>
  buildSuggestion({node:nodeFrom(source,filePath,match),replacement,source,headSha});

it('rewrites JSX text and proves the file still parses to the same structure', () => {
  const source='export const Hero=()=><h1>Unlock unprecedented potential</h1>;\n';
  const outcome=build(source,'landing.tsx','Manage your AI applications');
  expect(outcome.published).toBe(true);
  if(outcome.published)expect(outcome.suggestion.replacement).toContain('<h1>Manage your AI applications</h1>');
});

it('encodes HTML text and attribute replacements for their position', () => {
  const text=build('<h1>The ultimate solution</h1>','index.html','Review content before it ships');
  expect(text.published).toBe(true);
  if(text.published)expect(text.suggestion.replacement).toContain('Review content before it ships');
  // A quote inside an attribute value must not terminate the attribute.
  const attribute=build('<img src="a.png" alt="image" />','index.html','The "before" and "after" views',node=>node.sourceKind.startsWith('html_attribute'));
  expect(attribute.published).toBe(true);
  if(attribute.published)expect(attribute.suggestion.replacement).toContain('&quot;before&quot;');
});

it('re-encodes a locale value inside its existing quotes', () => {
  const outcome=build('{"hero.title":"Unlock unprecedented potential"}','locales/en.json','Say "hello" to your users');
  expect(outcome.published).toBe(true);
  // The embedded quotes are escaped, so the JSON remains valid.
  if(outcome.published)expect(outcome.suggestion.replacement).toContain('Say \\"hello\\" to your users');
});

it('refuses a replacement that would drop, add, alter or reorder a placeholder', () => {
  expect(validatePlaceholders('Hello {name}','Hello there')).toEqual(['PLACEHOLDER_REMOVED']);
  expect(validatePlaceholders('Hello there','Hello {name}')).toEqual(['PLACEHOLDER_ADDED']);
  expect(validatePlaceholders('Hello {name}','Hello {firstName}')).toEqual(['PLACEHOLDER_ALTERED','PLACEHOLDER_REMOVED']);
  expect(validatePlaceholders('You have {count} of {count}','You have {count}')).toEqual(['PLACEHOLDER_COUNT_CHANGED']);
  // Positional formats bind by position, so swapping them swaps what the user is shown.
  expect(validatePlaceholders('%s of %d','%d of %s')).toEqual(['PLACEHOLDER_REORDERED']);
  expect(validatePlaceholders('You have {{count}} alerts','You have {{count}} notifications')).toEqual([]);
});

it('never publishes a suggestion that loses a placeholder', () => {
  const outcome=build('{"greeting":"Hello {name}"}','locales/en.json','Hello there');
  expect(outcome).toEqual({published:false,reasons:['PLACEHOLDER_REMOVED']});
});

it('rejects prose that would inject an expression, element or attribute', () => {
  // Each of these is valid syntax and would still change what the file does. A brace is
  // reported as both markup and an added placeholder, and either reason alone blocks it.
  const expression=build('export const H=()=><h1>Old copy</h1>;','landing.tsx','{dangerous}');
  expect(expression.published).toBe(false);
  if(!expression.published)expect(expression.reasons).toContain('MARKUP_IN_REPLACEMENT');
  const element=build('export const H=()=><h1>Old copy</h1>;','landing.tsx','<script>alert(1)</script>');
  expect(element).toEqual({published:false,reasons:['MARKUP_IN_REPLACEMENT']});
  const injected=build('<img src="a.png" alt="image" />','index.html','x" onerror="alert(1)',node=>node.sourceKind.startsWith('html_attribute'));
  // The quote is entity-encoded, so the injected attribute becomes literal text.
  expect(injected.published).toBe(true);
  if(injected.published)expect(injected.suggestion.replacement).not.toContain('onerror="alert(1)"');
});

it('refuses an empty, unchanged or control-character replacement', () => {
  const source='export const H=()=><h1>Old copy</h1>;';
  expect(build(source,'landing.tsx','   ')).toMatchObject({published:false,reasons:['EMPTY_REPLACEMENT']});
  expect(build(source,'landing.tsx','Old copy')).toMatchObject({published:false,reasons:['UNCHANGED']});
  expect(build(source,'landing.tsx',`New${String.fromCharCode(7)}copy`)).toMatchObject({published:false,reasons:['CONTROL_CHARACTER']});
});

it('refuses a node the extractor already marked unsafe to replace', () => {
  // Entity-bearing HTML text: the raw source and the rendered text differ.
  const outcome=build('<p>Terms &amp; conditions apply</p>','index.html','Terms and conditions apply');
  expect(outcome).toEqual({published:false,reasons:['UNSAFE_NODE']});
});

it('refuses a suggestion for a line the pull request did not change', () => {
  const source='export const H=()=><h1>Old copy</h1>;';
  const node=nodeFrom(source,'landing.tsx',()=>true);
  expect(buildSuggestion({node,replacement:'New copy',source,headSha,changedLines:[99]}))
    .toMatchObject({published:false,reasons:['RANGE_NOT_IN_DIFF']});
  expect(buildSuggestion({node,replacement:'New copy',source,headSha,changedLines:[node.startLine]}).published).toBe(true);
});

it('reports every reason at once so a fallback to comment-only is explainable', () => {
  const outcome=build('{"greeting":"Hello {name}"}','locales/en.json','');
  expect(outcome.published).toBe(false);
  if(!outcome.published)expect(outcome.reasons).toEqual(['EMPTY_REPLACEMENT','PLACEHOLDER_REMOVED']);
});
