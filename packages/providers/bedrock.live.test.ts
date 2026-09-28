import { expect,it } from 'vitest';
import { ReviewerResponseSchema,VerificationSchema,candidateDigest,z } from '@humanize/domain';
import { BedrockProvider } from './src/index.js';

/**
 * Live Bedrock contract (ADR-041). AWS_BEARER_TOKEN_BEDROCK is the variable AWS documents for a
 * Bedrock API key; the model must support structured output in the chosen region.
 */
const key=process.env.AWS_BEARER_TOKEN_BEDROCK;
const region=process.env.HUMANIZE_BEDROCK_REGION;
const model=process.env.HUMANIZE_BEDROCK_MODEL;
if(!key||!region||!model)throw Error('Set AWS_BEARER_TOKEN_BEDROCK, HUMANIZE_BEDROCK_REGION and HUMANIZE_BEDROCK_MODEL; a live test is never silently skipped.');
const provider=new BedrockProvider(key,region);
const trace={traceId:'live-contract'};

it('passes the application-shaped capability probe', async () => {
  const capabilities=await provider.testConnection(model);
  expect(capabilities).toMatchObject({provider:'bedrock',model,structuredOutput:true});
  console.log(`bedrock probe ${model} in ${region}: ${Math.round(capabilities.latencyMs)} ms`);
});

it('returns the reviewer schema for content that deserves a finding', async () => {
  const result=await provider.generateStructured({
    model,timeoutMs:90000,traceContext:trace,schema:ReviewerResponseSchema,
    system:'You review user-visible product content. Report observable problems with the writing. Never claim text was machine authored. Quote exactly from the reviewed content. Return candidates and searches.',
    input:'Reviewed content (nodeId "node-1"):\n"Unlock unprecedented potential with our cutting-edge platform."\n\nReview category: ai_like_generic. Report at most one candidate, quoting exactly from the content above. Use nodeId "node-1", severity "minor", confidence between 0 and 1, evidence [], replacement null, requiresVerification true. Return searches [].',
  });
  const parsed=ReviewerResponseSchema.parse(result.data);
  expect(Array.isArray(parsed.candidates)).toBe(true);
  for(const candidate of parsed.candidates)expect('Unlock unprecedented potential with our cutting-edge platform.').toContain(candidate.exactText);
  console.log(`bedrock reviewer usage ${JSON.stringify(result.usage)} in ${Math.round(result.durationMs)} ms`);
});

it('returns the verifier schema bound to the candidate identity it was given', async () => {
  const candidate={nodeId:'node-1',category:'ai_like_generic' as const,severity:'minor' as const,confidence:0.9,
    exactText:'Unlock unprecedented potential',explanation:'Broad promotional wording',evidence:[],replacement:null,requiresVerification:true};
  const identity=candidateDigest(candidate);
  const result=await provider.generateStructured({
    model,timeoutMs:90000,traceContext:trace,schema:VerificationSchema,
    system:'You check proposed content-review findings before publication. Return one result per candidateId, using exactly the identifiers given.',
    input:`Reviewed content:\n"Unlock unprecedented potential with our cutting-edge platform."\n\nProposed finding:\ncandidateId: ${identity}\nquoted: Unlock unprecedented potential\nreasoning: Broad promotional wording\n\nReturn results with that exact candidateId, publish true or false, confidence between 0 and 1, and null for correctedExplanation, correctedReplacement and reasonIfSuppressed unless you change them.`,
  });
  const parsed=VerificationSchema.parse(result.data);
  expect(parsed.results).toHaveLength(1);
  expect(parsed.results[0]!.candidateId).toBe(identity);
});

it('refuses a model that does not exist', async () => {
  await expect(provider.generateStructured({model:'humanize.definitely-not-a-model-v0',timeoutMs:30000,traceContext:trace,schema:z.object({ok:z.boolean()}).strict(),system:'s',input:'i'}))
    .rejects.toThrow();
});
