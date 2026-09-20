import { expect,it,vi } from 'vitest';
import { REVIEW_MARKER } from '@humanize/github';
import type { ContentNode,DiffMap,ReviewSnapshot,RunnerResult } from '@humanize/domain';
import { publishResult } from './src/publish.js';
import { findingsFromResult } from '@humanize/review';

const headSha='b'.repeat(40);
const text='Unlock unprecedented potential with our cutting-edge platform.';
const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const snapshot:ReviewSnapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:7,
  baseSha:'a'.repeat(40),headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
const node=(overrides:Partial<ContentNode>={}):ContentNode=>({
  id:'node-1',repositoryId:'repo',commitSha:headSha,filePath:'app/page.tsx',blobSha:'d'.repeat(40),parser:'babel',parserVersion:'1',
  startLine:12,endLine:12,startOffset:0,endOffset:text.length,text,normalizedText:text.toLowerCase(),kind:'marketing',sourceKind:'jsx_text',
  dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config',suggestionSafe:true,...overrides});
const result=(overrides:Partial<RunnerResult>={}):RunnerResult=>({
  version:1,leaseId:'11111111-1111-4111-8111-111111111111',fence:1,runId:'22222222-2222-4222-8222-222222222222',snapshotHash:'digest',
  nodes:[node()],candidates:[{nodeId:'node-1',category:'ai_like_generic',severity:'minor',confidence:0.95,exactText:'Unlock unprecedented potential',
    explanation:'Broad promotional wording.',evidence:[],replacement:null,requiresVerification:true}],
  evidence:[],verification:{results:[]},diagnostics:[],...overrides});
const diff:DiffMap={repositoryId:'repo',baseSha:'a'.repeat(40),headSha,mergeBaseSha:'a'.repeat(40),
  files:[{oldPath:'app/page.tsx',newPath:'app/page.tsx',addedLines:[12],deletedLines:[],hunks:[{oldStart:1,oldCount:20,newStart:1,newCount:20}]}]};
const ports=(head=headSha,map:DiffMap=diff)=>{
  const calls:{route:string;parameters:Record<string,unknown>}[]=[];
  const routes:Record<string,unknown>={'GET /repos/{owner}/{repo}/pulls/{pull_number}':{head:{sha:head}},
    'POST /repos/{owner}/{repo}/check-runs':{id:1},'GET /repos/{owner}/{repo}/issues/{issue_number}/comments':[],
    'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews':{id:2}};
  return {calls,transport:async()=>({request:vi.fn(async(route:string,parameters:Record<string,unknown>)=>{calls.push({route,parameters});return {data:(routes[route]??{}) as never};})}),diff:async()=>map};
};

it('publishes a verified finding as an inline comment on the changed line', async () => {
  const p=ports();
  const outcome=await publishResult({snapshot,result:result()},p);
  expect(outcome).toMatchObject({reviewId:2,checkRunId:1});
  const review=p.calls.find(call=>call.route.endsWith('/reviews'))!.parameters as {comments:{path:string;line:number}[];body:string};
  expect(review.comments).toEqual([expect.objectContaining({path:'app/page.tsx',line:12})]);
  expect(review.body).toContain(REVIEW_MARKER);
});

it('discards a finding whose quotation is not in the content the runner supplied', async () => {
  // The runner is untrusted, so the control plane re-checks rather than relaying.
  const fabricated=result({candidates:[{nodeId:'node-1',category:'ai_like_generic',severity:'major',confidence:0.99,
    exactText:'wording that was never written',explanation:'Invented.',evidence:[],replacement:null,requiresVerification:false}]});
  expect(findingsFromResult(fabricated,snapshot)).toEqual([]);
  const p=ports();
  await publishResult({snapshot,result:fabricated},p);
  const review=p.calls.find(call=>call.route.endsWith('/reviews'));
  expect(review).toBeUndefined();
  expect(p.calls.find(call=>call.route.endsWith('/check-runs'))!.parameters).toMatchObject({conclusion:'success'});
});

it('discards content that does not belong to the reviewed commit', () => {
  expect(findingsFromResult(result({nodes:[node({commitSha:'f'.repeat(40)})]}),snapshot)).toEqual([]);
  expect(findingsFromResult(result({candidates:[{nodeId:'missing',category:'clarity',severity:'minor',confidence:0.9,
    exactText:'Unlock unprecedented potential',explanation:'x',evidence:[],replacement:null,requiresVerification:true}]}),snapshot)).toEqual([]);
});

it('publishes nothing when the pull request has moved on', async () => {
  const p=ports('c'.repeat(40));
  const outcome=await publishResult({snapshot,result:result()},p);
  expect(outcome).toMatchObject({skipped:'stale_head',current:'c'.repeat(40)});
  expect(p.calls.map(call=>call.route)).toEqual(['GET /repos/{owner}/{repo}/pulls/{pull_number}']);
});

it('holds inline comments to the configured budget', async () => {
  const many=result({
    nodes:Array.from({length:8},(_,index)=>node({id:`node-${index}`,filePath:`app/page-${index}.tsx`,stableKey:`stable-${index}`})),
    candidates:Array.from({length:8},(_,index)=>({nodeId:`node-${index}`,category:'ai_like_generic' as const,severity:'minor' as const,
      confidence:0.95,exactText:'Unlock unprecedented potential',explanation:'Broad promotional wording.',evidence:[],replacement:null,requiresVerification:true})),
  });
  expect(findingsFromResult(many,snapshot)).toHaveLength(8);
  const wide:DiffMap={...diff,files:Array.from({length:8},(_,index)=>({oldPath:`app/page-${index}.tsx`,newPath:`app/page-${index}.tsx`,
    addedLines:[12],deletedLines:[],hunks:[{oldStart:1,oldCount:20,newStart:1,newCount:20}]}))};
  const p=ports(headSha,wide);
  await publishResult({snapshot,result:many,maxSubjectiveInline:2},p);
  const review=p.calls.find(call=>call.route.endsWith('/reviews'))!.parameters as {body:string;comments:unknown[]};
  // Only the budgeted findings are inline; the rest are named in the summary.
  expect(review.comments).toHaveLength(2);
  expect(review.body).toContain('Further observations not posted inline');
});

it('schedules publication once an accepted result is stored, and not for a duplicate', async () => {
  const { createApi } = await import('./src/app.js');
  const scheduled: string[] = [];
  const store = {
    register: vi.fn(), heartbeat: vi.fn(), claim: vi.fn(), renew: vi.fn(), fail: vi.fn(),
    leaseScope: vi.fn(async () => ({ installationId: 7, githubRepositoryId: 99, owner: 'acme', name: 'site', headSha, runId: 'r', snapshot })),
    accept: vi.fn(async () => ({ duplicate: false })),
  };
  const app = createApi({
    webhookSecret: 'secret', sink: { ingest: vi.fn(async () => true) }, runners: store as never,
    tokens: { scopedToken: vi.fn() } as never,
    publication: { schedule: async result => { scheduled.push(result.runId); } },
  });
  const envelope = { ...result(), leaseId: '11111111-1111-4111-8111-111111111111' };
  try {
    const accepted = await app.inject({ method: 'POST', url: `/runner/leases/${envelope.leaseId}/result`, headers: { authorization: `Bearer ${'c'.repeat(43)}` }, payload: envelope as never });
    expect(accepted.statusCode).toBe(200);
    expect(scheduled).toEqual([envelope.runId]);
    // A re-sent result must not schedule a second publication of the same review.
    store.accept = vi.fn(async () => ({ duplicate: true }));
    await app.inject({ method: 'POST', url: `/runner/leases/${envelope.leaseId}/result`, headers: { authorization: `Bearer ${'c'.repeat(43)}` }, payload: envelope as never });
    expect(scheduled).toEqual([envelope.runId]);
  } finally { await app.close(); }
});
