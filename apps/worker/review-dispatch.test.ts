import { expect,it,vi } from 'vitest';
import { dispatchReview } from './src/review-worker.js';
import type { ReviewRunRecord } from './src/review-worker.js';
import type { JobPayload, ReviewSnapshot } from '@humanize/domain';

const snapshot=(executionMode:'runner'|'cloud'):ReviewSnapshot=>({
  version:1,organizationId:'org',repositoryId:'repo',installationId:1,owner:'acme',repository:'site',pullNumber:1,
  baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'hash',
  executionMode,retentionMode:'ephemeral',
  reviewer:{provider:'ollama',model:'m',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},
  verifier:{provider:'ollama',model:'m',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},
  language:'en',allowUnevaluatedLanguage:false,
});
const payload:JobPayload={version:1,organizationId:'org',repositoryId:'repo',runId:'run',traceId:'t',idempotencyKey:'k'};
const record=(state:string,mode:'runner'|'cloud'='runner'):ReviewRunRecord=>
  ({organizationId:'org',repositoryId:'repo',runId:'run',state,attempt:0,snapshot:snapshot(mode)});

it('offers a runner job as a lease and moves the run to QUEUED',async()=>{
  const runners={enqueue:vi.fn(async()=>{})},queued=vi.fn(async()=>{});
  const outcome=await dispatchReview(payload,{run:async()=>record('RECEIVED'),runners,queued});
  expect(outcome).toEqual({status:'leased',runId:'run'});
  expect(runners.enqueue).toHaveBeenCalledWith('org','repo','run');
  expect(queued).toHaveBeenCalledOnce();
});

it('never routes a cloud run to the local executor',async()=>{
  // INV-007: private execution and cloud execution must never be silently interchanged, and
  // no cloud executor exists, so this reports unavailable rather than running it locally.
  const runners={enqueue:vi.fn(async()=>{})};
  const outcome=await dispatchReview(payload,{run:async()=>record('RECEIVED','cloud'),runners,queued:async()=>{}});
  expect(outcome).toEqual({status:'skipped',reason:'cloud_execution_unavailable'});
  expect(runners.enqueue).not.toHaveBeenCalled();
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
