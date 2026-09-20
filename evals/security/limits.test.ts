import { expect,it,vi } from 'vitest';
import { Category,LIMITS } from '@humanize/domain';
import type { ContentNode,ModelProvider,ReviewSnapshot } from '@humanize/domain';
import { extract } from '@humanize/extractors';
import { EphemeralContextIndex,buildContext } from '@humanize/retrieval';
import { reviewNodes } from '@humanize/review';
import type { CategoryName } from '@humanize/review';

const headSha='b'.repeat(40);
const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const snapshot:ReviewSnapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,
  baseSha:'a'.repeat(40),headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',
  reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
const enabled=Object.fromEntries(Category.options.map(c=>[c,true])) as Record<CategoryName,boolean>;
const extractFile=(filePath:string,source:string)=>extract({repositoryId:'repo',commitSha:headSha,blobSha:'d'.repeat(40),filePath,source});
const node=(id:string,text:string):ContentNode=>({id,repositoryId:'repo',commitSha:headSha,filePath:`app/${id}.tsx`,blobSha:'d'.repeat(40),
  parser:'babel',parserVersion:'1',startLine:1,endLine:1,startOffset:0,endOffset:text.length,text,normalizedText:text.toLowerCase(),
  kind:'marketing',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:`s-${id}`,mappingVersion:1,
  segments:[],extractionConfigHash:'config',suggestionSafe:true});

it('refuses a file past the size limit, and says which one', () => {
  const oversized='<p>'+'word '.repeat(LIMITS.fileBytes/5)+'</p>';
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(LIMITS.fileBytes);
  const result=extractFile('huge.html',oversized);
  expect(result.nodes).toEqual([]);
  // Skipping silently would let a caller believe the file was reviewed.
  expect(result.diagnostics).toEqual([{code:'FILE_TOO_LARGE',filePath:'huge.html'}]);
});

it('stops at the node limit and reports the truncation', () => {
  const many=Array.from({length:LIMITS.nodesPerFile+200},(_,i)=>`<p>Sentence ${i}</p>`).join('');
  const result=extractFile('many.html',many);
  expect(result.nodes).toHaveLength(LIMITS.nodesPerFile);
  expect(result.diagnostics).toContainEqual({code:'NODE_LIMIT_REACHED',filePath:'many.html'});
});

it('refuses a single node longer than the limit rather than truncating its text', () => {
  const enormous=`<p>${'word '.repeat(LIMITS.nodeChars)}</p>`;
  const result=extractFile('long.html',enormous);
  // A truncated node would be reviewed as if it were the whole sentence.
  expect(result.nodes).toEqual([]);
});

it('holds context within its token budget however much is available', async () => {
  const target=node('node-0','Unlock unprecedented potential with our cutting-edge platform.');
  const crowd=Array.from({length:400},(_,i)=>node(`node-${i+1}`,`Unlock unprecedented potential variant number ${i}.`));
  const index=new EphemeralContextIndex(snapshot,[target,...crowd]);
  const context=await buildContext({node:target,index});
  expect(context.tokens).toBeLessThanOrEqual(LIMITS.contextTokens);
  const tight=await buildContext({node:target,index,tokenBudget:200});
  expect(tight.tokens).toBeLessThanOrEqual(200);
  // Truncation is reported, so nobody mistakes a partial context for the whole repository.
  expect(tight.truncated).toBe(true);
});

it('stays responsive while indexing a repository-sized corpus', async () => {
  const nodes=Array.from({length:5000},(_,i)=>node(`node-${i}`,`Product sentence number ${i} about reviewing content.`));
  const started=Date.now();
  const index=new EphemeralContextIndex(snapshot,nodes);
  const results=await index.search({text:'reviewing content',limit:10});
  const elapsed=Date.now()-started;
  expect(index.size).toBe(5000);
  expect(results).toHaveLength(10);
  expect(elapsed,`indexing and searching 5000 nodes took ${elapsed}ms`).toBeLessThan(5000);
});

it('records a provider outage as a diagnostic rather than losing the other findings', async () => {
  const good=node('node-good','Unlock unprecedented potential with our cutting-edge platform.');
  const bad=node('node-bad','Our revolutionary state-of-the-art seamless solution.');
  let call=0;
  const flaky={id:'ollama',testConnection:vi.fn(),generateStructured:vi.fn(async()=>{
    if(++call===1)throw Error('TRANSPORT');
    return {data:{candidates:[],searches:[]},provider:'ollama',model:'m',durationMs:1};
  })} as unknown as ModelProvider;
  const index=new EphemeralContextIndex(snapshot,[good,bad]);
  const outcome=await reviewNodes(snapshot,[bad,good],{reviewer:flaky,reviewerModel:'m',verifier:flaky,verifierModel:'m',
    context:async n=>(await buildContext({node:n,index})).evidence,
    rules:()=>[]},{enabled});
  // One node defeated by an outage must not discard the review of every other node.
  expect(outcome.failures).toHaveLength(1);
  expect(outcome.reviewed).toBe(2);
});

it('reports every skipped file so coverage is never overstated', () => {
  const skipped=[
    extractFile('config/app.json','{"name":"not a locale"}'),
    extractFile('script.py','print("unsupported format")'),
    extractFile('huge.md','x'.repeat(LIMITS.fileBytes+1)),
  ];
  for(const result of skipped){
    expect(result.nodes).toEqual([]);
    // Silence is the failure mode this product keeps rediscovering: every skip is named.
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }
  expect(skipped.map(r=>r.diagnostics[0]!.code)).toEqual(['NOT_A_LOCALE_SOURCE','UNSUPPORTED_FORMAT','FILE_TOO_LARGE']);
});
