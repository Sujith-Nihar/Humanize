import { expect,it } from 'vitest';
import type { ContentNode } from '@humanize/domain';
import { evaluateRules } from './src/index.js';

const make=(text:string,overrides:Partial<ContentNode>={}):ContentNode=>({
  id:'node-1',repositoryId:'repo',commitSha:'b'.repeat(40),filePath:'app/page.tsx',blobSha:'d'.repeat(40),
  parser:'babel',parserVersion:'1',startLine:5,endLine:5,startOffset:0,endOffset:text.length,
  text,normalizedText:text.toLowerCase(),kind:'marketing',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,
  placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config',suggestionSafe:true,
  ...overrides,
});
const ids=(node:ContentNode,config={})=>evaluateRules(node,config).map(signal=>signal.ruleId);

it('flags low-information promotional wording with a span inside the node', () => {
  const node=make('Unlock unprecedented potential with our cutting-edge platform.');
  const signals=evaluateRules(node);
  // Three distinct phrases also raise the aggregate cluster signal (ADR-037).
  expect(signals.map(s=>s.ruleId)).toEqual(['promotional-cluster','promotional:unlock unprecedented','promotional:unprecedented potential','promotional:cutting-edge']);
  for(const found of signals){
    // Every span is taken from the node's own text, never from a model.
    expect(node.text.slice(found.start,found.end)).toBe(found.matchedText);
    expect(found.evidence).toMatchObject({type:'rule',nodeId:node.id,filePath:'app/page.tsx',line:5,ruleId:found.ruleId});
  }
});

it('leaves ordinary product writing alone', () => {
  expect(ids(make('Humanize reviews the content your users actually read, before it ships.'))).toEqual([]);
  expect(ids(make('Connect a repository to start reviewing pull requests.'))).toEqual([]);
});

it('applies configured avoided wording, preferred terms and prohibited phrases', () => {
  const node=make('Our AI tool is 100% secure and revolutionary.');
  const signals=evaluateRules(node,{avoid:['revolutionary'],terminology:{'AI tool':'AI application'},blockingRules:[{type:'forbidden_phrase',phrase:'100% secure'}]});
  const blocking=signals.filter(s=>s.blocking);
  expect(blocking).toHaveLength(1);
  expect(blocking[0]).toMatchObject({ruleId:'forbidden:100% secure',severity:'major',category:'terminology'});
  expect(signals.map(s=>s.ruleId)).toContain('terminology:AI tool');
  expect(signals.map(s=>s.ruleId)).toContain('avoid:revolutionary');
  // Configured phrases match case-insensitively but the reported text is the author's own.
  expect(signals.find(s=>s.ruleId==='terminology:AI tool')!.matchedText).toBe('AI tool');
});

it('matches a preferred term only as a whole word', () => {
  expect(ids(make('The AI toolkit ships today.'),{terminology:{'AI tool':'AI application'}})).toEqual([]);
});

it('detects repeated sentence openings and uniform rhythm', () => {
  const repeated=make('This helps teams move faster. This keeps content consistent. This reduces review time.');
  expect(ids(repeated)).toContain('repeated-opening:this');
  const uniform=make('The platform helps teams write clearly today. The service keeps content consistent always. The product reduces review effort daily.');
  expect(ids(uniform)).toContain('uniform-sentence-length');
  expect(ids(make('Short one. A considerably longer sentence that runs on for a while in this paragraph. Tiny.'))).not.toContain('uniform-sentence-length');
});

it('flags dense superlatives and adverbs only in long enough text', () => {
  const dense=make('This is the most amazing and truly incredible platform, perfectly built for the ultimate best experience that modern teams could possibly want from any product today.');
  expect(ids(dense)).toContain('superlative-density');
  // Density below twenty words is statistically meaningless, so it is not measured.
  expect(ids(make('The best experience'))).toEqual([]);
  expect(ids(make('This is the most amazing and truly incredible ultimate best platform.'))).toEqual([]);
});

it('reports every occurrence in deterministic order', () => {
  const node=make('Cutting-edge tooling. Cutting-edge results.');
  const signals=evaluateRules(node);
  expect(signals).toHaveLength(2);
  expect(signals[0]!.start).toBeLessThan(signals[1]!.start);
  expect(evaluateRules(node).map(s=>s.evidence.id)).toEqual(signals.map(s=>s.evidence.id));
});

it('never claims the text was machine authored', () => {
  const descriptions=evaluateRules(make('Unlock unprecedented potential with our cutting-edge platform.')).map(s=>s.description.toLowerCase());
  for(const description of descriptions){
    for(const forbidden of ['ai-generated','ai generated','written by ai','machine authored','chatgpt','llm'])expect(description).not.toContain(forbidden);
  }
});

it('lets an objectively countable pattern stand alone, but not a statistical one', () => {
  const clustered=evaluateRules(make('Our revolutionary, state-of-the-art platform is truly game-changing for modern teams.'));
  const cluster=clustered.find(s=>s.ruleId==='promotional-cluster');
  // Three distinct promotional phrases in one passage is arithmetic, not judgement.
  expect(cluster).toMatchObject({standalone:true,blocking:false,category:'ai_like_generic'});
  const repeated=evaluateRules(make('This helps teams. This keeps content consistent. This reduces review time.'));
  expect(repeated.find(s=>s.ruleId==='repeated-opening:this')).toMatchObject({standalone:true});
  // Two phrases is not a cluster, and density remains evidence only.
  expect(evaluateRules(make('Our cutting-edge and revolutionary platform.')).find(s=>s.ruleId==='promotional-cluster')).toBeUndefined();
  const dense=evaluateRules(make('This is the most amazing and truly incredible platform, perfectly built for the ultimate best experience that modern teams could possibly want from any product today.'));
  expect(dense.find(s=>s.ruleId==='superlative-density')?.standalone).toBeUndefined();
});

it('matches a phrase across ordinary inflection', () => {
  // Literal matching missed these, dropping a passage below the cluster threshold.
  for(const text of ['leveraging the power of our platform','leverages the power of AI','leverage the power of data']){
    expect(ids(make(text))).toContain('promotional:leverage the power of');
  }
});

it('flags padded phrasing, which is distinct from promotional vocabulary', () => {
  const padded=evaluateRules(make('The dashboard provides users with the ability to view all applications.'));
  const found=padded.find(s=>s.ruleId.startsWith('padding:'));
  expect(found).toMatchObject({category:'clarity',standalone:true});
  expect(found!.matchedText.toLowerCase()).toContain('provides users with the ability to');
  expect(ids(make('It is important to note that the worker must be running.'))).toContain('padding:it is important to note that');
  // Ordinary direct writing carries no padding.
  expect(ids(make('The dashboard lets you view all applications.'))).toEqual([]);
  expect(ids(make('Run the migration before starting the worker.'))).toEqual([]);
});

it('offers a deletion only where removing the construction is unambiguous',()=>{
  const tagline=evaluateRules(make('Scientifically Engineered Sound — Designed for the Mind'),{})
    .find(s=>s.ruleId==='construction:tagline-appositive');
  expect(tagline?.replacement).toBe('Scientifically Engineered Sound');

  const strawman=evaluateRules(make('Each soundscape is intentionally designed — not randomly generated — to support focus.'),{})
    .find(s=>s.ruleId==='construction:strawman-contrast');
  expect(strawman?.replacement).toBe('Each soundscape is intentionally designed to support focus.');

  // Rewriting prose is the model's job. A construction with no safe deletion offers nothing
  // rather than guessing, and the finding stays comment-only.
  const reframe=evaluateRules(make("It's Not Just Music — It's Science You Can Feel"),{})
    .find(s=>s.ruleId==='construction:negation-reframe');
  expect(reframe).toBeDefined();
  expect(reframe?.replacement).toBeUndefined();

  const opener=evaluateRules(make('In a world of endless playlists, we take a different approach.'),{})
    .find(s=>s.ruleId==='construction:scene-setting-opener');
  expect(opener?.replacement).toBeUndefined();
});
