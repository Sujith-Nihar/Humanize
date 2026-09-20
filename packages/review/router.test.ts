import { expect,it } from 'vitest';
import { Category } from '@humanize/domain';
import type { ContentNode } from '@humanize/domain';
import { routeNode } from './src/index.js';
import type { CategoryName } from './src/index.js';

const all=Object.fromEntries(Category.options.map(category=>[category,true])) as Record<CategoryName,boolean>;
const make=(text:string,overrides:Partial<ContentNode>={}):ContentNode=>({
  id:'node-1',repositoryId:'repo',commitSha:'b'.repeat(40),filePath:'app/page.tsx',blobSha:'d'.repeat(40),
  parser:'babel',parserVersion:'1',startLine:1,endLine:1,startOffset:0,endOffset:text.length,
  text,normalizedText:text.toLowerCase(),kind:'paragraph',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,
  placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config',suggestionSafe:true,
  ...overrides,
});

it('sends a marketing paragraph for the full review set', () => {
  const decision=routeNode(make('Unlock unprecedented potential with our cutting-edge platform for modern teams everywhere.',{kind:'marketing'}),{enabled:all});
  expect(decision.eligible).toBe(true);
  expect(decision.categories).toContain('ai_like_generic');
  expect(decision.categories).toContain('unsupported_claim');
  expect(decision.categories).toContain('approved_voice');
});

it('does not send a short button label for long-form prose review', () => {
  const decision=routeNode(make('Save changes',{kind:'button'}),{enabled:all});
  expect(decision.eligible).toBe(true);
  expect(decision.categories).toEqual(['approved_voice','clarity','terminology']);
  expect(decision.categories).not.toContain('ai_like_generic');
  expect(decision.categories).not.toContain('repetition');
});

it('prioritizes clarity and correctness for accessibility text', () => {
  expect(routeNode(make('Close the notification panel',{kind:'accessibility'}),{enabled:all}).categories).toEqual(['clarity','terminology']);
  expect(routeNode(make('→',{kind:'css_generated'}),{enabled:all}).categories).toEqual(['clarity','terminology']);
});

it('routes documentation and headings by length', () => {
  const short=routeNode(make('Getting started',{kind:'heading'}),{enabled:all});
  expect(short.categories).not.toContain('ai_like_generic');
  const long=routeNode(make('Getting started with repository aware content review in your existing workflow',{kind:'heading'}),{enabled:all});
  expect(long.categories).toContain('ai_like_generic');
  const brief=routeNode(make('Run the migration before starting the worker.',{kind:'documentation'}),{enabled:all});
  expect(brief.categories).toContain('claim_inconsistency');
  expect(brief.categories).not.toContain('repetition');
});

it('never routes a category the configuration disabled', () => {
  const enabled={...all,ai_like_generic:false,repetition:false};
  const decision=routeNode(make('Unlock unprecedented potential with our cutting-edge platform for modern teams.',{kind:'marketing'}),{enabled});
  expect(decision.categories).not.toContain('ai_like_generic');
  expect(decision.categories).not.toContain('repetition');
  const none=Object.fromEntries(Category.options.map(category=>[category,false])) as Record<CategoryName,boolean>;
  expect(routeNode(make('Anything at all',{kind:'marketing'}),{enabled:none})).toMatchObject({eligible:false,reason:'no_enabled_category',categories:[]});
});

it('withholds content that is not confidently visible or not resolved', () => {
  expect(routeNode(make('active',{visibilityConfidence:0.05}),{enabled:all})).toMatchObject({eligible:false,reason:'below_visibility_threshold'});
  expect(routeNode(make('{product.title}',{dynamic:true}),{enabled:all})).toMatchObject({eligible:false,reason:'dynamic_unresolved'});
  expect(routeNode(make('   '),{enabled:all})).toMatchObject({eligible:false,reason:'too_short'});
});

it('is deterministic and returns sorted distinct categories', () => {
  const node=make('A reasonably long paragraph of product documentation that explains the workflow.',{kind:'documentation'});
  const first=routeNode(node,{enabled:all});
  expect(routeNode(node,{enabled:all})).toEqual(first);
  expect([...first.categories].sort()).toEqual(first.categories);
  expect(new Set(first.categories).size).toBe(first.categories.length);
});
