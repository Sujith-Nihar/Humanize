import { expect,it,vi } from 'vitest';
import { LeaseLostError,RunnerClient,RunnerUnauthorizedError,TransportError } from './src/client.js';

const capabilities={protocolVersion:1 as const,schemaVersion:'humanize-runner-v1' as const,version:'0.1.0',models:['fixture'],labels:[],localOnly:true as const};
const snapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40),configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:{provider:'ollama',model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},verifier:{provider:'ollama',model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']},language:'en',allowUnevaluatedLanguage:false};
const lease={leaseId:'11111111-1111-4111-8111-111111111111',fence:1,runId:'22222222-2222-4222-8222-222222222222',expiresAt:new Date().toISOString(),expiresInMs:120000,snapshot};
const respond=(status:number,body?:unknown)=>vi.fn(async()=>new Response(body===undefined?null:JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
const build=(fetch:typeof globalThis.fetch)=>new RunnerClient({controlPlaneUrl:'https://control.example/',credential:'c'.repeat(43),fetch});

it('only ever initiates outbound requests and authenticates with the credential', async()=>{
  const fetch=respond(200,lease);
  expect(await build(fetch).claim()).toMatchObject({leaseId:lease.leaseId,fence:1});
  const [url,init]=fetch.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.toString()).toBe('https://control.example/runner/leases');
  expect(init.method).toBe('POST');
  expect((init.headers as Record<string,string>).authorization).toBe(`Bearer ${'c'.repeat(43)}`);
});

it('reports an idle control plane as no work rather than an error', async()=>{
  expect(await build(respond(204)).claim()).toBeNull();
});

it('maps lease loss, revocation and server faults to distinct failures', async()=>{
  await expect(build(respond(409)).renew(lease.leaseId,1)).rejects.toBeInstanceOf(LeaseLostError);
  await expect(build(respond(401)).renew(lease.leaseId,1)).rejects.toBeInstanceOf(RunnerUnauthorizedError);
  await expect(build(respond(403)).claim()).rejects.toBeInstanceOf(RunnerUnauthorizedError);
  await expect(build(respond(503)).claim()).rejects.toBeInstanceOf(TransportError);
  await expect(build(vi.fn(async()=>{throw Object.assign(Error('socket hang up'),{name:'TypeError'});})).claim()).rejects.toBeInstanceOf(TransportError);
  await expect(build(respond(400)).claim()).rejects.toThrow('RUNNER_REQUEST_REJECTED');
});

it('refuses a control-plane payload that does not match the protocol', async()=>{
  await expect(build(respond(200,{...lease,fence:0})).claim()).rejects.toThrow();
  await expect(build(respond(200,{...lease,snapshot:{...snapshot,headSha:'nope'}})).claim()).rejects.toThrow();
  await expect(build(respond(200,{...lease,unexpected:true})).claim()).rejects.toThrow();
  await expect(build(vi.fn(async()=>new Response('not json',{status:200}))).claim()).rejects.toBeInstanceOf(TransportError);
});

it('will not send an authenticated request before registration', async()=>{
  const fetch=respond(200,lease);
  const client=new RunnerClient({controlPlaneUrl:'https://control.example/',fetch});
  await expect(client.claim()).rejects.toBeInstanceOf(RunnerUnauthorizedError);
  expect(fetch).not.toHaveBeenCalled();
  const registration=respond(201,{runnerId:'runner',credential:'d'.repeat(43)});
  const registering=new RunnerClient({controlPlaneUrl:'https://control.example/',fetch:registration});
  expect(await registering.register('e'.repeat(43),capabilities)).toBe('runner');
});

it('rejects a control-plane address that is not HTTP', ()=>{
  expect(()=>new RunnerClient({controlPlaneUrl:'file:///etc/passwd'})).toThrow('INVALID_CONTROL_PLANE_URL');
});
