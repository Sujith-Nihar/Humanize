import { beforeAll,expect,it } from 'vitest';
import { ReviewerResponseSchema,VerificationSchema,candidateDigest,z } from '@humanize/domain';
import { OllamaProvider } from './src/index.js';

const baseUrl=process.env.HUMANIZE_OLLAMA_BASE_URL;
const model=process.env.HUMANIZE_OLLAMA_MODEL;
if(!baseUrl||!model)throw Error('Set HUMANIZE_OLLAMA_BASE_URL and HUMANIZE_OLLAMA_MODEL; a live test is never silently skipped.');
const provider=new OllamaProvider(baseUrl,true);
const trace={traceId:'live-contract'};

beforeAll(async()=>{
  const available=await provider.listModels();
  expect(available.some(name=>name===model||name===`${model}:latest`)).toBe(true);
});

it('passes the application-shaped capability probe', async () => {
  const capabilities=await provider.testConnection(model);
  expect(capabilities).toMatchObject({provider:'ollama',model,structuredOutput:true});
  expect(capabilities.latencyMs).toBeGreaterThan(0);
});

it('returns the reviewer schema for content that deserves a finding', async () => {
  const result=await provider.generateStructured({
    model,timeoutMs:180000,traceContext:trace,schema:ReviewerResponseSchema,
    system:'You review user-visible product content. Report observable problems with the writing. Never claim text was machine authored. Quote exactly from the reviewed content. Return candidates and searches.',
    input:'Reviewed content (nodeId "node-1"):\n"Unlock unprecedented potential with our cutting-edge platform."\n\nReview category: ai_like_generic. Report at most one candidate, quoting exactly from the content above. Use nodeId "node-1", severity "minor", confidence between 0 and 1, evidence [], replacement null, requiresVerification true. Return searches [].',
  });
  const parsed=ReviewerResponseSchema.parse(result.data);
  // The contract requirement is a schema-valid response, not a particular judgement.
  expect(Array.isArray(parsed.candidates)).toBe(true);
  for(const candidate of parsed.candidates){
    expect('Unlock unprecedented potential with our cutting-edge platform.').toContain(candidate.exactText);
  }
});

it('returns the reviewer schema, and an empty result, for acceptable content', async () => {
  const result=await provider.generateStructured({
    model,timeoutMs:180000,traceContext:trace,schema:ReviewerResponseSchema,
    system:'You review user-visible product content. Report nothing when the content is acceptable; an empty candidates list is a good answer. Return searches [].',
    input:'Reviewed content (nodeId "node-1"):\n"Connect a repository to start reviewing pull requests."\n\nReview category: ai_like_generic. Return candidates [] if there is no problem.',
  });
  expect(ReviewerResponseSchema.parse(result.data).candidates).toEqual([]);
});

it('returns the verifier schema bound to the candidate identity it was given', async () => {
  const candidate={nodeId:'node-1',category:'ai_like_generic' as const,severity:'minor' as const,confidence:0.9,
    exactText:'Unlock unprecedented potential',explanation:'Broad promotional wording',evidence:[],replacement:null,requiresVerification:true};
  const identity=candidateDigest(candidate);
  const result=await provider.generateStructured({
    model,timeoutMs:180000,traceContext:trace,schema:VerificationSchema,
    system:'You check proposed content-review findings before publication. Return one result per candidateId, using exactly the identifiers given.',
    input:`Reviewed content:\n"Unlock unprecedented potential with our cutting-edge platform."\n\nProposed finding:\ncandidateId: ${identity}\nquoted: Unlock unprecedented potential\nreasoning: Broad promotional wording\n\nReturn results with that exact candidateId, publish true or false, confidence between 0 and 1, and null for correctedExplanation, correctedReplacement and reasonIfSuppressed unless you change them.`,
  });
  const parsed=VerificationSchema.parse(result.data);
  expect(parsed.results).toHaveLength(1);
  // Binding by identity is what lets the control plane trust the verdict (ADR-036).
  expect(parsed.results[0]!.candidateId).toBe(identity);
});

it('refuses a model that is not installed', async () => {
  await expect(provider.generateStructured({model:'definitely-not-installed:0b',timeoutMs:30000,traceContext:trace,schema:z.object({ok:z.boolean()}).strict(),system:'s',input:'i'}))
    .rejects.toThrow();
});
