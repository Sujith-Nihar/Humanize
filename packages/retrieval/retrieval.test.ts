import { expect,it } from 'vitest';
import { LIMITS } from '@humanize/domain';
import type { ContentNode } from '@humanize/domain';
import { EphemeralContextIndex,buildContext,estimateTokens,trigramSimilarity } from './src/index.js';

const headSha='b'.repeat(40);
const snapshot={repositoryId:'repo',headSha};
let counter=0;
const make=(text:string,overrides:Partial<ContentNode>={}):ContentNode=>({
  id:`node-${++counter}`,repositoryId:'repo',commitSha:headSha,filePath:'app/page.tsx',blobSha:'d'.repeat(40),
  parser:'babel',parserVersion:'1',startLine:1,endLine:1,startOffset:0,endOffset:text.length,
  text,normalizedText:text.toLowerCase(),kind:'paragraph',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,
  placeholders:[],stableKey:`stable-${counter}`,mappingVersion:1,segments:[],extractionConfigHash:'config',suggestionSafe:true,
  ...overrides,
});

it('retrieves related content with no database and no embeddings', async () => {
  const target=make('Unlock unprecedented potential with our cutting-edge platform');
  const related=make('Our cutting-edge platform unlocks potential for teams',{filePath:'docs/marketing.md'});
  const unrelated=make('Set the database connection timeout in seconds',{filePath:'docs/ops.md'});
  const index=new EphemeralContextIndex(snapshot,[target,related,unrelated]);
  const results=await index.search({text:target.text,limit:5,excludeNodeId:target.id});
  expect(results[0]).toMatchObject({type:'repo_content',nodeId:related.id,filePath:'docs/marketing.md',revision:headSha});
  expect(results.map(r=>r.nodeId)).not.toContain(target.id);
  expect(results.map(r=>r.nodeId)).not.toContain(unrelated.id);
});

it('refuses content from another repository or another commit', () => {
  const node=make('Anything');
  expect(()=>new EphemeralContextIndex(snapshot,[{...node,repositoryId:'other'}])).toThrow('NODE_OUT_OF_SNAPSHOT');
  expect(()=>new EphemeralContextIndex(snapshot,[{...node,commitSha:'f'.repeat(40)}])).toThrow('NODE_OUT_OF_SNAPSHOT');
});

it('is deterministic and bounded', async () => {
  const nodes=Array.from({length:50},(_,index)=>make(`Shared wording sample number ${index}`,{filePath:`docs/page-${index}.md`}));
  const index=new EphemeralContextIndex(snapshot,nodes);
  const first=await index.search({text:'shared wording sample',limit:7});
  const second=await index.search({text:'shared wording sample',limit:7});
  expect(first.map(r=>r.id)).toEqual(second.map(r=>r.id));
  expect(first).toHaveLength(7);
  // Equal scores fall back to a stable key rather than insertion order.
  const shuffled=new EphemeralContextIndex(snapshot,[...nodes].reverse());
  expect((await shuffled.search({text:'shared wording sample',limit:7})).map(r=>r.id)).toEqual(first.map(r=>r.id));
});

it('returns nothing rather than noise for an empty or stopword-only query', async () => {
  const index=new EphemeralContextIndex(snapshot,[make('Manage your applications')]);
  expect(await index.search({text:'',limit:5})).toEqual([]);
  expect(await index.search({text:'the and of it',limit:5})).toEqual([]);
});

it('finds near-duplicate content and ignores merely similar topics', () => {
  const original=make('Humanize reviews the content your users actually read.');
  const copied=make('Humanize reviews the content your users actually read!',{filePath:'docs/about.md'});
  const different=make('Humanize is a GitHub App for repository-aware review.',{filePath:'docs/intro.md'});
  const index=new EphemeralContextIndex(snapshot,[original,copied,different]);
  const duplicates=index.nearDuplicates(original);
  expect(duplicates).toHaveLength(1);
  expect(duplicates[0]).toMatchObject({nodeId:copied.id});
  expect(trigramSimilarity(original.text,different.text)).toBeLessThan(0.8);
});

it('prefers neighbours in the same file, nearest first', () => {
  const target=make('The reviewed sentence',{startLine:40});
  const near=make('Immediately below',{startLine:44});
  const far=make('Much further down',{startLine:400});
  const elsewhere=make('Another file entirely',{filePath:'docs/other.md',startLine:41});
  const index=new EphemeralContextIndex(snapshot,[target,far,near,elsewhere]);
  expect(index.neighbours(target).map(r=>r.nodeId)).toEqual([near.id,far.id]);
});

it('carries a revision and content hash so evidence can be revalidated later', async () => {
  const node=make('Unlock unprecedented potential');
  const other=make('Unlock unprecedented potential today',{filePath:'docs/a.md'});
  const index=new EphemeralContextIndex(snapshot,[node,other]);
  const [record]=await index.search({text:node.text,limit:1,excludeNodeId:node.id});
  expect(record).toMatchObject({revision:headSha,filePath:'docs/a.md',line:1});
  expect(record!.contentHash).toHaveLength(64);
  const changed=new EphemeralContextIndex(snapshot,[node,{...other,text:'Different wording entirely'}]);
  const [afterChange]=await changed.search({text:node.text,limit:1,excludeNodeId:node.id});
  expect(afterChange?.contentHash).not.toBe(record!.contentHash);
});

it('builds context in priority order and stops at the budget', async () => {
  const target=make('Unlock unprecedented potential',{startLine:10});
  const neighbour=make('A nearby sentence in the same file',{startLine:12});
  const duplicate=make('Unlock unprecedented potential',{filePath:'docs/copy.md'});
  const related=make('Unprecedented potential for platform teams',{filePath:'docs/marketing.md'});
  const index=new EphemeralContextIndex(snapshot,[target,neighbour,duplicate,related]);
  const rule={id:'rule-1',type:'rule' as const,description:'Avoid unprecedented',revision:'config',contentHash:'hash'};
  const context=await buildContext({node:target,index,rules:[rule]});
  expect(context.truncated).toBe(false);
  expect(context.evidence[0]).toMatchObject({nodeId:neighbour.id});
  expect(context.evidence[1]).toMatchObject({id:'rule-1'});
  expect(context.evidence.map(r=>r.nodeId)).toContain(duplicate.id);
  // Every record is distinct even though tiers overlap.
  expect(new Set(context.evidence.map(r=>r.id)).size).toBe(context.evidence.length);
  expect(context.tokens).toBeLessThanOrEqual(LIMITS.contextTokens);

  const tight=await buildContext({node:target,index,rules:[rule],tokenBudget:estimateTokens('Nearby content in the same file')+10});
  expect(tight.truncated).toBe(true);
  expect(tight.tokens).toBeLessThanOrEqual(estimateTokens('Nearby content in the same file')+10);
  expect(tight.evidence.length).toBeLessThan(context.evidence.length);
});

it('works when the repository offers no related content at all', async () => {
  const lonely=make('The only sentence in the repository');
  const index=new EphemeralContextIndex(snapshot,[lonely]);
  const context=await buildContext({node:lonely,index});
  expect(context).toMatchObject({evidence:[],tokens:0,truncated:false});
  expect(index.size).toBe(1);
});
