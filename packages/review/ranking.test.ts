import { expect,it } from 'vitest';
import type { ContentNode,ValidatedFinding } from '@humanize/domain';
import { planPublication,scoreFinding } from './src/index.js';

const text='Unlock unprecedented potential with our cutting-edge platform for modern teams.';
let counter=0;
const node=(overrides:Partial<ContentNode>={}):ContentNode=>({
  id:`node-${++counter}`,repositoryId:'repo',commitSha:'b'.repeat(40),filePath:'app/page.tsx',blobSha:'d'.repeat(40),parser:'babel',parserVersion:'1',
  startLine:10,endLine:10,startOffset:0,endOffset:text.length,text,normalizedText:text.toLowerCase(),kind:'marketing',sourceKind:'jsx_text',
  dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:`stable-${counter}`,mappingVersion:1,segments:[],extractionConfigHash:'config',suggestionSafe:true,...overrides,
});
const finding=(overrides:Partial<ValidatedFinding>={}):ValidatedFinding=>({
  nodeId:'node-1',category:'ai_like_generic',severity:'minor',confidence:0.95,exactText:'Unlock unprecedented potential',
  explanation:'Broad promotional wording',evidence:[],replacement:null,requiresVerification:true,
  fingerprint:`fp-${++counter}`,node:node(),evidenceRecords:[],deterministic:false,blocking:false,verificationConfidence:0.95,...overrides,
});

it('scores a stronger finding above a weaker one, deterministically', () => {
  const strong=finding({severity:'major',confidence:0.99,verificationConfidence:0.99});
  const weak=finding({severity:'nit',confidence:0.5,verificationConfidence:0.5});
  expect(scoreFinding(strong)).toBeGreaterThan(scoreFinding(weak));
  expect(scoreFinding(strong)).toBe(scoreFinding({...strong}));
  // Content that is barely visible cannot outrank content a user certainly reads.
  expect(scoreFinding(finding({node:node({visibilityConfidence:0.2})}))).toBeLessThan(scoreFinding(finding()));
});

it('merges a finding that restates another about the same text', () => {
  const shared=node();
  const whole=finding({node:shared,nodeId:shared.id,exactText:'Unlock unprecedented potential with our cutting-edge platform',confidence:0.99,verificationConfidence:0.99});
  const part=finding({node:shared,nodeId:shared.id,exactText:'unprecedented potential',confidence:0.8,verificationConfidence:0.8});
  const plan=planPublication([whole,part]);
  // Exactly the problem live testing exposed: a sentence and a sub-phrase of it.
  expect(plan.inline).toHaveLength(1);
  expect(plan.inline[0]!.exactText).toBe('Unlock unprecedented potential with our cutting-edge platform');
  expect(plan.dropped).toBe(1);
});

it('keeps distinct findings about different places and different categories', () => {
  const a=finding({node:node({filePath:'app/a.tsx'})});
  const b=finding({node:node({filePath:'app/b.tsx'})});
  const other=finding({node:a.node,nodeId:a.node.id,category:'clarity'});
  expect(planPublication([a,b]).inline).toHaveLength(2);
  expect(planPublication([a,other]).inline).toHaveLength(2);
});

it('merges findings proposing the same replacement for the same place', () => {
  const shared=node();
  const first=finding({node:shared,nodeId:shared.id,category:'clarity',replacement:'Manage your applications',confidence:0.99,verificationConfidence:0.99});
  const second=finding({node:shared,nodeId:shared.id,category:'repository_style',replacement:'Manage your applications',confidence:0.9,verificationConfidence:0.9});
  expect(planPublication([first,second]).inline).toHaveLength(1);
});

it('holds subjective findings to the budget and moves the rest to the summary', () => {
  const many=Array.from({length:9},(_,index)=>finding({node:node({filePath:`app/page-${index}.tsx`}),confidence:0.9-index/100}));
  const plan=planPublication(many);
  expect(plan.inline).toHaveLength(5);
  expect(plan.summary).toHaveLength(4);
  // The strongest findings are the ones that take the inline slots.
  expect(plan.inline[0]!.score).toBeGreaterThanOrEqual(plan.summary[0]!.score);
  expect(planPublication(many,{maxSubjectiveInline:2}).inline).toHaveLength(2);
  // The budget cannot be raised past the product default.
  expect(planPublication(many,{maxSubjectiveInline:50}).inline).toHaveLength(5);
});

it('never lets a deterministic policy violation lose its place to the budget', () => {
  const subjective=Array.from({length:6},(_,index)=>finding({node:node({filePath:`app/page-${index}.tsx`})}));
  const blocking=finding({node:node({filePath:'app/policy.tsx'}),category:'terminology',severity:'major',deterministic:true,blocking:true,confidence:1,verificationConfidence:1});
  const plan=planPublication([...subjective,blocking]);
  expect(plan.inline).toContainEqual(expect.objectContaining({blocking:true}));
  expect(plan.inline.filter(f=>!f.deterministic)).toHaveLength(5);
});

it('excludes nitpicks by default but keeps deterministic ones', () => {
  const nit=finding({severity:'nit'});
  const deterministicNit=finding({severity:'nit',deterministic:true,blocking:true});
  expect(planPublication([nit]).inline).toHaveLength(0);
  expect(planPublication([nit]).dropped).toBe(1);
  expect(planPublication([nit],{includeNits:true}).inline).toHaveLength(1);
  expect(planPublication([deterministicNit]).inline).toHaveLength(1);
});

it('produces the same plan however the findings arrive', () => {
  const set=Array.from({length:7},(_,index)=>finding({node:node({filePath:`app/page-${index}.tsx`}),confidence:0.9}));
  const forward=planPublication(set).inline.map(f=>f.fingerprint);
  const reversed=planPublication([...set].reverse()).inline.map(f=>f.fingerprint);
  expect(reversed).toEqual(forward);
});

it('posts at most one comment per category on a single node', () => {
  const shared=node();
  const sentences=['Unlock unprecedented potential','with our cutting-edge platform','for modern teams.'];
  const many=sentences.map((exactText,index)=>finding({node:shared,nodeId:shared.id,category:'clarity',exactText,confidence:0.9-index/100}));
  const other=finding({node:shared,nodeId:shared.id,category:'ai_like_generic'});
  const plan=planPublication([...many,other]);
  // Three separate quotations from one string would stack three comments on one line.
  expect(plan.inline).toHaveLength(2);
  expect(plan.inline.map(f=>f.category).sort()).toEqual(['ai_like_generic','clarity']);
  expect(plan.dropped).toBe(2);
});
