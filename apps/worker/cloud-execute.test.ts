import { expect,it,vi } from 'vitest';
import { executeCloudReview } from './src/cloud-worker.js';
import type { CloudPorts } from './src/cloud-worker.js';
import type { ExecutionReport } from '@humanize/execution';
import type { ContentNode,JobPayload,ModelProvider,ReviewSnapshot } from '@humanize/domain';

const headSha='b'.repeat(40);
const CREDENTIAL='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const hosted={provider:'bedrock' as const,model:'us.anthropic.claude-haiku-4-5-20251001-v1:0',credentialRef:CREDENTIAL,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const local={provider:'ollama' as const,model:'qwen3:8b',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const snapshot=(overrides:Partial<ReviewSnapshot>={}):ReviewSnapshot=>({
  version:1,organizationId:'org',repositoryId:'repo',installationId:1,owner:'acme',repository:'site',pullNumber:1,
  baseSha:'a'.repeat(40),headSha,configSha:'c'.repeat(40),configHash:'hash',
  executionMode:'cloud',retentionMode:'ephemeral',reviewer:hosted,verifier:hosted,
  language:'en',allowUnevaluatedLanguage:false,...overrides,
});
const payload:JobPayload={version:1,organizationId:'org',repositoryId:'repo',runId,traceId:'t',idempotencyKey:'k'};

const node:ContentNode={id:'node-1',repositoryId:'repo',commitSha:headSha,filePath:'app/page.tsx',blobSha:'d'.repeat(40),parser:'babel',parserVersion:'1',startLine:1,endLine:1,startOffset:0,endOffset:43,text:'Unlock unprecedented potential with our tool',normalizedText:'unlock unprecedented potential with our tool',kind:'heading',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config-hash',suggestionSafe:true};
const report=(nodes:ContentNode[]=[node],candidates:ExecutionReport['result']['candidates']=[]):ExecutionReport=>({
  inspectedFiles:3,extractedNodes:nodes.length,changedNodes:nodes.length,
  result:{version:1,runId,snapshotHash:'ignored-by-these-doubles',nodes,candidates,evidence:[],verification:{results:[]},diagnostics:[]},
});

const model={} as ModelProvider;
const ports=(overrides:Partial<CloudPorts>={}):CloudPorts=>({
  run:async()=>({organizationId:'org',repositoryId:'repo',runId,state:'QUEUED',attempt:0,snapshot:snapshot()}),
  credential:async()=>'secret',
  provider:()=>model,
  token:async()=>'ghs_read_only',
  execute:async()=>report(),
  schedulePublication:async()=>{},
  config:{enabled:{ai_like_generic:true} as never},
  ...overrides,
});

it('executes a cloud run and hands the result to publication', async () => {
  const schedulePublication=vi.fn(async()=>{});
  const outcome=await executeCloudReview(payload,ports({schedulePublication}));
  expect(outcome).toEqual({status:'executed',runId,candidates:0,inspectedFiles:3,changedNodes:1});
  expect(schedulePublication).toHaveBeenCalledOnce();
});

it('refuses work marked for private execution', async () => {
  // A runner exists so that content never leaves the customer's hardware. Executing it here
  // because a queue message arrived would defeat exactly that (INV-007).
  const execute=vi.fn(async()=>report());
  const run=async()=>({organizationId:'org',repositoryId:'repo',runId,state:'QUEUED',attempt:0,snapshot:snapshot({executionMode:'runner',reviewer:local,verifier:local})});
  const outcome=await executeCloudReview(payload,ports({run,execute}));
  expect(outcome).toEqual({status:'skipped',reason:'not_a_cloud_run'});
  expect(execute).not.toHaveBeenCalled();
});

it('refuses a hosted profile whose credential is missing, revoked or unnamed', async () => {
  // Never a fallback to another provider: the administrator chose this one.
  const execute=vi.fn(async()=>report());
  const unnamed=async()=>({organizationId:'org',repositoryId:'repo',runId,state:'QUEUED',attempt:0,snapshot:snapshot({reviewer:{...hosted,credentialRef:null}})});
  expect(await executeCloudReview(payload,ports({run:unnamed,execute}))).toEqual({status:'skipped',reason:'no_credential'});
  const revoked=async()=>{throw Error('SECRET_UNAVAILABLE');};
  expect(await executeCloudReview(payload,ports({credential:revoked,execute}))).toEqual({status:'skipped',reason:'no_credential'});
  expect(execute).not.toHaveBeenCalled();
});

it('resolves the reviewer and verifier credentials independently', async () => {
  const second='33333333-3333-4333-8333-333333333333';
  const credential=vi.fn(async(_organizationId:string,_provider:string,reference:string)=>`secret:${reference}`);
  const provider=vi.fn((_profile:ReviewSnapshot['reviewer'],_secret:string|null)=>model);
  const run=async()=>({organizationId:'org',repositoryId:'repo',runId,state:'QUEUED',attempt:0,snapshot:snapshot({verifier:{...hosted,credentialRef:second}})});
  await executeCloudReview(payload,ports({run,credential,provider}));
  expect(credential.mock.calls.map(call=>call[2])).toEqual([CREDENTIAL,second]);
  // Neither profile may borrow the other's secret.
  expect(provider.mock.calls.map(call=>call[1])).toEqual([`secret:${CREDENTIAL}`,`secret:${second}`]);
});

it('asks for no credential when policy names a local model', async () => {
  const credential=vi.fn(async()=>'secret');
  const run=async()=>({organizationId:'org',repositoryId:'repo',runId,state:'QUEUED',attempt:0,snapshot:snapshot({reviewer:local,verifier:local})});
  expect((await executeCloudReview(payload,ports({run,credential}))).status).toBe('executed');
  expect(credential).not.toHaveBeenCalled();
});

it('refuses to publish a result that fails validation', async () => {
  // The executor is trusted code; the model behind it is not. A fabricated quotation must
  // not reach a pull request even when the control plane itself produced the envelope.
  const schedulePublication=vi.fn(async()=>{});
  const fabricated=report([node],[{nodeId:'node-1',category:'ai_like_generic',severity:'minor',confidence:0.9,exactText:'wording nobody wrote',explanation:'x',evidence:[],replacement:null,requiresVerification:true}]);
  const outcome=await executeCloudReview(payload,ports({execute:async()=>fabricated,schedulePublication}));
  expect(outcome).toEqual({status:'skipped',reason:'invalid_result'});
  expect(schedulePublication).not.toHaveBeenCalled();
});

it('retries a failed execution and never publishes a partial one', async () => {
  const schedulePublication=vi.fn(async()=>{});
  const outcome=await executeCloudReview(payload,ports({execute:async()=>{throw Error('CLONE_FAILED');},schedulePublication}));
  expect(outcome).toEqual({status:'retry',errorClass:'CLONE_FAILED'});
  expect(schedulePublication).not.toHaveBeenCalled();
});

it('does not re-run a finished or cancelled run', async () => {
  const execute=vi.fn(async()=>report());
  for(const state of ['COMPLETE','CANCELLED','STALE','FAILED_FINAL']){
    const run=async()=>({organizationId:'org',repositoryId:'repo',runId,state,attempt:0,snapshot:snapshot()});
    expect(await executeCloudReview(payload,ports({run,execute}))).toEqual({status:'skipped',reason:'terminal_run'});
  }
  expect(await executeCloudReview(payload,ports({run:async()=>null}))).toEqual({status:'skipped',reason:'unknown_run'});
  expect(await executeCloudReview({...payload,runId:undefined},ports({execute}))).toEqual({status:'skipped',reason:'no_run_id'});
  expect(execute).not.toHaveBeenCalled();
});
