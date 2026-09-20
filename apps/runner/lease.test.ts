import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { LeaseLostError,RunnerUnauthorizedError,TransportError } from './src/client.js';
import type { Lease,LeaseCredential,RunnerClient } from './src/client.js';
import { runLease } from './src/lease.js';

const lease:Lease={leaseId:'11111111-1111-4111-8111-111111111111',fence:3,runId:'22222222-2222-4222-8222-222222222222',expiresAt:new Date(120000).toISOString(),expiresInMs:120000,snapshot:{} as Lease['snapshot']};
const credential:LeaseCredential={token:'ghs_fixture',expiresAt:new Date(3600000).toISOString(),repository:{owner:'acme',name:'site'},headSha:'b'.repeat(40),runId:lease.runId};
const client=(overrides:Partial<Record<'renew'|'fail'|'leaseToken',unknown>>={})=>({
  leaseToken:vi.fn(async()=>credential),
  renew:vi.fn(async()=>120000),
  fail:vi.fn(async()=>undefined),
  ...overrides,
} as unknown as RunnerClient);
const options={renewIntervalMs:30000,safetyMarginMs:5000};

beforeEach(()=>vi.useFakeTimers({now:0}));
afterEach(()=>vi.useRealTimers());

it('renews on schedule while the executor runs and returns its value', async()=>{
  const api=client();
  const session=runLease(api,lease,async({signal,credential:issued})=>{
    expect(issued.token).toBe('ghs_fixture');
    for(let step=0;step<3;step++)await vi.advanceTimersByTimeAsync(30000);
    expect(signal.aborted).toBe(false);
    return 'result';
  },options);
  await expect(session).resolves.toEqual({status:'completed',value:'result'});
  expect(api.renew).toHaveBeenCalledTimes(3);
  expect(api.renew).toHaveBeenLastCalledWith(lease.leaseId,lease.fence);
  expect(api.fail).not.toHaveBeenCalled();
});

it('aborts the executor and reports nothing when the lease is cancelled or revoked', async()=>{
  const api=client({renew:vi.fn(async()=>{throw new LeaseLostError();})});
  let observed:unknown;
  const session=runLease(api,lease,async({signal})=>{
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    observed=signal.reason;
    throw signal.reason;
  },options);
  await vi.advanceTimersByTimeAsync(30000);
  await expect(session).resolves.toEqual({status:'lost'});
  expect(observed).toBeInstanceOf(LeaseLostError);
  // A lost lease is owned by another runner, so neither a result nor a failure is reported.
  expect(api.fail).not.toHaveBeenCalled();
});

it('survives a partition that is shorter than the lease it already holds', async()=>{
  const renew=vi.fn()
    .mockImplementationOnce(async()=>{throw new TransportError('ETIMEDOUT');})
    .mockImplementationOnce(async()=>120000);
  const api=client({renew});
  const session=runLease(api,lease,async({signal})=>{
    await vi.advanceTimersByTimeAsync(60000);
    return signal.aborted?'aborted':'survived';
  },options);
  await expect(session).resolves.toEqual({status:'completed',value:'survived'});
  expect(renew).toHaveBeenCalledTimes(2);
});

it('gives up when a partition outlasts the lease', async()=>{
  const api=client({renew:vi.fn(async()=>{throw new TransportError('ECONNREFUSED');})});
  const session=runLease(api,lease,async({signal})=>{
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    throw signal.reason;
  },options);
  // Renewal keeps failing; once the held lease is within its safety margin the runner stops.
  await vi.advanceTimersByTimeAsync(180000);
  await expect(session).resolves.toEqual({status:'lost'});
  expect(api.fail).not.toHaveBeenCalled();
});

it('reports a retryable failure and a permanent failure differently', async()=>{
  const retryableApi=client();
  await expect(runLease(retryableApi,lease,async()=>{throw Error('extraction timed out');},options)).resolves.toEqual({status:'failed',retryable:true});
  expect(retryableApi.fail).toHaveBeenCalledWith(lease.leaseId,lease.fence,true);

  const permanentApi=client();
  await expect(runLease(permanentApi,lease,async()=>{throw Object.assign(Error('model not installed'),{retryable:false});},options)).resolves.toEqual({status:'failed',retryable:false});
  expect(permanentApi.fail).toHaveBeenCalledWith(lease.leaseId,lease.fence,false);

  const unauthorizedApi=client();
  await expect(runLease(unauthorizedApi,lease,async()=>{throw new RunnerUnauthorizedError();},options)).resolves.toEqual({status:'failed',retryable:false});
});

it('treats a lease lost while reporting a failure as lost, not failed', async()=>{
  const api=client({fail:vi.fn(async()=>{throw new LeaseLostError();})});
  await expect(runLease(api,lease,async()=>{throw Error('boom');},options)).resolves.toEqual({status:'lost'});
});

it('stops the renewal timer and abandons the credential on every exit path', async()=>{
  for(const execute of [async()=>'done',async()=>{throw Error('boom');}]){
    const api=client();
    const outcome=await runLease(api,lease,execute,options);
    expect(['completed','failed']).toContain(outcome.status);
    const renewals=(api.renew as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(300000);
    expect((api.renew as ReturnType<typeof vi.fn>).mock.calls.length).toBe(renewals);
  }
});

it('does not start work when the job-scoped credential cannot be issued', async()=>{
  const execute=vi.fn();
  const api=client({leaseToken:vi.fn(async()=>{throw new LeaseLostError();})});
  await expect(runLease(api,lease,execute,options)).resolves.toEqual({status:'lost'});
  expect(execute).not.toHaveBeenCalled();
  expect(api.renew).not.toHaveBeenCalled();
});

it('uploads the result while the lease is still held, and drops it when the lease is lost', async () => {
  const uploaded:string[]=[];
  const api=client();
  const completed=await runLease(api,lease,async()=>'review',options,async value=>{uploaded.push(value);});
  expect(completed).toEqual({status:'completed',value:'review'});
  expect(uploaded).toEqual(['review']);

  // Work finished after the lease was lost belongs to another runner and is never reported.
  const lostApi=client({renew:vi.fn(async()=>{throw new LeaseLostError();})});
  const dropped:string[]=[];
  const session=runLease(lostApi,lease,async({signal})=>{
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    return 'review';
  },options,async value=>{dropped.push(value);});
  await vi.advanceTimersByTimeAsync(30000);
  await expect(session).resolves.toEqual({status:'lost'});
  expect(dropped).toEqual([]);
});
