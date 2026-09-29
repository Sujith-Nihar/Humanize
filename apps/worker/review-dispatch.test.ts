import { expect,it,vi } from 'vitest';
import { DEFAULT_REVIEW_SCOPE } from '@humanize/domain';
import { dispatchReview } from './src/review-worker.js';
import type { ReviewRunRecord } from './src/review-worker.js';
import type { JobPayload, ReviewSnapshot } from '@humanize/domain';

const snapshot=(executionMode:'runner'|'cloud'):ReviewSnapshot=>({
  version:1,organizationId:'org',repositoryId:'repo',installationId:1,owner:'acme',repository:'site',pullNumber:1,
  baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'hash',
  executionMode,retentionMode:'ephemeral',
  reviewer:{provider:'ollama',model:'m',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},
  verifier:{provider:'ollama',model:'m',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},
  language:'en',allowUnevaluatedLanguage:false,review:DEFAULT_REVIEW_SCOPE,
});
const payload:JobPayload={version:1,organizationId:'org',repositoryId:'repo',runId:'run',traceId:'t',idempotencyKey:'k'};
const record=(state:string,mode:'runner'|'cloud'='runner',hosted=false):ReviewRunRecord=>{
  const base=snapshot(mode);
  const model=hosted?{provider:'bedrock' as const,model:'m',credentialRef:'11111111-1111-4111-8111-111111111111',maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en' as const]}:base.reviewer;
  return {organizationId:'org',repositoryId:'repo',runId:'run',state,attempt:0,snapshot:{...base,reviewer:model,verifier:model}};
};

it('offers a runner job as a lease and moves the run to QUEUED',async()=>{
  const runners={enqueue:vi.fn(async()=>{})},queued=vi.fn(async()=>{});
  const outcome=await dispatchReview(payload,{run:async()=>record('RECEIVED'),runners,queued});
  expect(outcome).toEqual({status:'leased',runId:'run'});
  expect(runners.enqueue).toHaveBeenCalledWith('org','repo','run');
  expect(queued).toHaveBeenCalledOnce();
});

it('never routes a cloud run to the local executor',async()=>{
  // INV-007: private execution and cloud execution must never be silently interchanged, so a
  // cloud run with no cloud executor configured is reported rather than run on a runner.
  const runners={enqueue:vi.fn(async()=>{})};
  const outcome=await dispatchReview(payload,{run:async()=>record('RECEIVED','cloud',true),runners,queued:async()=>{}});
  expect(outcome).toEqual({status:'skipped',reason:'cloud_execution_unavailable'});
  expect(runners.enqueue).not.toHaveBeenCalled();
});

it('never routes a runner run to the cloud executor',async()=>{
  // The converse of INV-007, and the one that would leak content: a private review must not
  // reach a hosted model because a cloud executor happens to be configured.
  const cloud={enqueue:vi.fn(async()=>{})},runners={enqueue:vi.fn(async()=>{})};
  const outcome=await dispatchReview(payload,{run:async()=>record('RECEIVED','runner'),runners,cloud,queued:async()=>{}});
  expect(outcome).toEqual({status:'leased',runId:'run'});
  expect(cloud.enqueue).not.toHaveBeenCalled();
});

it('queues a cloud run for the cloud executor',async()=>{
  const cloud={enqueue:vi.fn(async()=>{})},runners={enqueue:vi.fn(async()=>{})},queued=vi.fn(async()=>{});
  const outcome=await dispatchReview(payload,{run:async()=>record('RECEIVED','cloud',true),runners,cloud,queued});
  expect(outcome).toEqual({status:'cloud',runId:'run'});
  expect(cloud.enqueue).toHaveBeenCalledOnce();
  expect(runners.enqueue).not.toHaveBeenCalled();
  expect(queued).toHaveBeenCalledOnce();
});

it('refuses a hosted cloud run that names no credential',async()=>{
  // Rather than falling back to a local model, which is a provider the administrator did
  // not choose for this organisation.
  const cloud={enqueue:vi.fn(async()=>{})};
  const uncredentialed=record('RECEIVED','cloud',true);
  const snap=uncredentialed.snapshot as ReviewSnapshot;
  const run=async()=>({...uncredentialed,snapshot:{...snap,reviewer:{...snap.reviewer,credentialRef:null},verifier:{...snap.verifier,credentialRef:null}}});
  const outcome=await dispatchReview(payload,{run,runners:{enqueue:async()=>{}},cloud,queued:async()=>{}});
  expect(outcome).toEqual({status:'skipped',reason:'no_cloud_credential'});
  expect(cloud.enqueue).not.toHaveBeenCalled();
});

it('does not re-queue a cloud run a redelivery already dispatched',async()=>{
  const cloud={enqueue:vi.fn(async()=>{})};
  const outcome=await dispatchReview(payload,{run:async()=>record('QUEUED','cloud',true),runners:{enqueue:async()=>{}},cloud,queued:async()=>{}});
  expect(outcome).toEqual({status:'skipped',reason:'already_dispatched'});
  expect(cloud.enqueue).not.toHaveBeenCalled();
});

it('does not advance a run a redelivery already dispatched',async()=>{
  const queued=vi.fn(async()=>{});
  const outcome=await dispatchReview(payload,{run:async()=>record('QUEUED'),runners:{enqueue:async()=>{}},queued});
  expect(outcome).toEqual({status:'skipped',reason:'already_dispatched'});
  expect(queued).not.toHaveBeenCalled();
});

it('refuses a terminal or unknown run',async()=>{
  const runners={enqueue:vi.fn(async()=>{})};
  const ports={runners,queued:async()=>{}};
  expect(await dispatchReview(payload,{...ports,run:async()=>record('CANCELLED')})).toEqual({status:'skipped',reason:'terminal_run'});
  expect(await dispatchReview(payload,{...ports,run:async()=>null})).toEqual({status:'skipped',reason:'unknown_run'});
  expect(runners.enqueue).not.toHaveBeenCalled();
});
