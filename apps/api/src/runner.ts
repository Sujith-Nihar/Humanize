import { RunnerCapabilitiesSchema,RunnerRegistrationSchema,RunnerResultSchema,validateRunnerResult,z } from '@humanize/domain';
import type { RunnerCapabilities,ReviewSnapshot,RunnerResult } from '@humanize/domain';
import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';

export interface LeaseScope {installationId:number;githubRepositoryId:number;owner:string;name:string;headSha:string;runId:string;snapshot:ReviewSnapshot;}
export interface RunnerService {
  register(token:string,capabilities:RunnerCapabilities):Promise<{runnerId:string;credential:string}>;
  heartbeat(credential:string,capabilities:RunnerCapabilities):Promise<void>;
  leaseScope(credential:string,leaseId:string,fence:number,options?:{forResult?:boolean}):Promise<LeaseScope>;
  claim(credential:string):Promise<{leaseId:string;fence:number;runId:string;expiresAt:string;expiresInMs:number;snapshot:unknown}|null>;
  renew(credential:string,leaseId:string,fence:number):Promise<{expiresAt:string;expiresInMs:number}>;
  fail(credential:string,leaseId:string,fence:number,retryable:boolean):Promise<void>;
  accept(credential:string,result:RunnerResult):Promise<{duplicate:boolean}>;
}
/** Mints the single-repository, read-only GitHub credential a leased job may use. */
export interface TokenIssuer {
  scopedToken(installationId:number,githubRepositoryId:number,role:'read'):Promise<{token:string;expiresAt:string}>;
}

const LeaseTokenRequest=z.object({fence:z.number().int().positive()}).strict();
const LeaseFailureRequest=z.object({fence:z.number().int().positive(),retryable:z.boolean()}).strict();
const LEASE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PROTOCOL_VERSION=1,SCHEMA_VERSION='humanize-runner-v1';
// Registration, heartbeat and lease bodies are small; anything larger is refused before parsing.
const BODY_LIMIT=8*1024;
// A result carries extracted nodes and evidence, so it is bounded separately and still capped.
const RESULT_LIMIT=8*1024*1024;
const CREDENTIAL=/^[A-Za-z0-9_-]{32,200}$/;
// Only these store failures are reportable; every other cause returns a generic error so
// internal diagnostics never reach an unauthenticated caller.
const REPORTABLE=new Map<string,number>([['INVALID_ENROLLMENT',401],['RUNNER_UNAUTHORIZED',401],['INVALID_SCOPE',403],['LEASE_LOST',409],['LEASE_MISMATCH',409],['CONFLICTING_RESULT',409]]);

function bearer(request:FastifyRequest):string|null {
  const header=request.headers.authorization;
  if(typeof header!=='string'||!header.startsWith('Bearer '))return null;
  const token=header.slice(7);return CREDENTIAL.test(token)?token:null;
}

/** Rejects an incompatible runner before any state changes, without trusting the body shape. */
function incompatible(value:unknown):boolean {
  const capabilities=(value??{}) as Record<string,unknown>;
  return (capabilities.protocolVersion!==undefined&&capabilities.protocolVersion!==PROTOCOL_VERSION)
    ||(capabilities.schemaVersion!==undefined&&capabilities.schemaVersion!==SCHEMA_VERSION);
}

async function guard(reply:FastifyReply,run:()=>Promise<FastifyReply>):Promise<FastifyReply> {
  try{return await run();}
  catch(error){
    const status=REPORTABLE.get(error instanceof Error?error.message:'');
    if(status)return reply.code(status).send({error:(error as Error).message});
    return reply.code(503).send({error:'RUNNER_SERVICE_UNAVAILABLE'});
  }
}

/** Schedules publication of an accepted result; the control plane alone talks to GitHub. */
export interface PublicationScheduler { schedule(result:RunnerResult,scope:LeaseScope):Promise<void>; }

export function registerRunnerRoutes(app:FastifyInstance,service:RunnerService,issuer:TokenIssuer,publication?:PublicationScheduler):void {
  app.post('/runner/registrations',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const body=(request.body??{}) as Record<string,unknown>;
    if(incompatible(body.capabilities))return reply.code(409).send({error:'INCOMPATIBLE_PROTOCOL',protocolVersion:PROTOCOL_VERSION,schemaVersion:SCHEMA_VERSION});
    const parsed=RunnerRegistrationSchema.safeParse(body);
    if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
    return guard(reply,async()=>{
      const registered=await service.register(parsed.data.enrollmentToken,parsed.data.capabilities);
      // The credential is returned exactly once, at enrollment; it is stored only as a hash.
      return reply.code(201).send(registered);
    });
  });
  app.post('/runner/heartbeats',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const credential=bearer(request);
    if(!credential)return reply.code(401).send({error:'RUNNER_UNAUTHORIZED'});
    const body=(request.body??{}) as Record<string,unknown>;
    if(incompatible(body))return reply.code(409).send({error:'INCOMPATIBLE_PROTOCOL',protocolVersion:PROTOCOL_VERSION,schemaVersion:SCHEMA_VERSION});
    const parsed=RunnerCapabilitiesSchema.safeParse(body);
    if(!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
    return guard(reply,async()=>{await service.heartbeat(credential,parsed.data);return reply.code(204).send();});
  });
  app.post('/runner/leases/:leaseId/token',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const credential=bearer(request);
    if(!credential)return reply.code(401).send({error:'RUNNER_UNAUTHORIZED'});
    const {leaseId}=request.params as {leaseId:string};
    const parsed=LeaseTokenRequest.safeParse(request.body??{});
    if(!LEASE_ID.test(leaseId)||!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
    return guard(reply,async()=>{
      // The issuer is reached only after the lease is proven live for this runner, so a
      // revoked, superseded, expired or foreign lease can never obtain a credential.
      const scope=await service.leaseScope(credential,leaseId,parsed.data.fence);
      const issued=await issuer.scopedToken(scope.installationId,scope.githubRepositoryId,'read');
      return reply.code(201).send({token:issued.token,expiresAt:issued.expiresAt,repository:{owner:scope.owner,name:scope.name},headSha:scope.headSha,runId:scope.runId});
    });
  });
  app.post('/runner/leases',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const credential=bearer(request);
    if(!credential)return reply.code(401).send({error:'RUNNER_UNAUTHORIZED'});
    return guard(reply,async()=>{
      const lease=await service.claim(credential);
      // An idle runner is told there is no work rather than being handed an empty lease.
      return lease?reply.code(200).send(lease):reply.code(204).send();
    });
  });
  app.post('/runner/leases/:leaseId/renewal',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const credential=bearer(request);
    if(!credential)return reply.code(401).send({error:'RUNNER_UNAUTHORIZED'});
    const {leaseId}=request.params as {leaseId:string};
    const parsed=LeaseTokenRequest.safeParse(request.body??{});
    if(!LEASE_ID.test(leaseId)||!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
    // A cancelled, revoked, superseded or expired lease fails renewal, which is how a
    // runner learns to stop working.
    return guard(reply,async()=>reply.code(200).send(await service.renew(credential,leaseId,parsed.data.fence)));
  });
  app.post('/runner/leases/:leaseId/failure',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const credential=bearer(request);
    if(!credential)return reply.code(401).send({error:'RUNNER_UNAUTHORIZED'});
    const {leaseId}=request.params as {leaseId:string};
    const parsed=LeaseFailureRequest.safeParse(request.body??{});
    if(!LEASE_ID.test(leaseId)||!parsed.success)return reply.code(400).send({error:'INVALID_REQUEST'});
    return guard(reply,async()=>{await service.fail(credential,leaseId,parsed.data.fence,parsed.data.retryable);return reply.code(204).send();});
  });
  app.post('/runner/leases/:leaseId/result',{bodyLimit:RESULT_LIMIT},async(request,reply)=>{
    const credential=bearer(request);
    if(!credential)return reply.code(401).send({error:'RUNNER_UNAUTHORIZED'});
    const {leaseId}=request.params as {leaseId:string};
    const parsed=RunnerResultSchema.safeParse(request.body??{});
    if(!LEASE_ID.test(leaseId)||!parsed.success||parsed.data.leaseId!==leaseId)return reply.code(400).send({error:'INVALID_REQUEST'});
    return guard(reply,async()=>{
      // The lease is resolved first, so a stale, superseded or revoked submission is refused
      // before any of its content is examined or stored.
      const scope=await service.leaseScope(credential,leaseId,parsed.data.fence,{forResult:true});
      const violations=validateRunnerResult(parsed.data,scope.snapshot);
      // Violation codes only: the payload is untrusted and must not be echoed back.
      if(violations.length)return reply.code(422).send({error:'INVALID_RESULT',violations});
      const accepted=await service.accept(credential,parsed.data);
      // Scheduled, never published inline: a runner must not wait on GitHub, and a failed
      // publish has to be retried by the durable queue rather than lost with the response.
      if(!accepted.duplicate&&publication)await publication.schedule(parsed.data,scope);
      return reply.code(200).send({accepted:true,duplicate:accepted.duplicate});
    });
  });
}
