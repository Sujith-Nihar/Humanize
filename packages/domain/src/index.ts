import { z } from 'zod';
export { z };
import { fingerprint,safePath } from '@humanize/shared';

export const PROTOCOL_VERSION = 1 as const;
export const Id = z.string().min(1).max(200);
export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const PathSchema = z.string().refine(safePath, 'Unsafe repository path');
export const ProviderId = z.enum(['openai', 'gemini', 'openrouter', 'ollama']);
export const RetentionMode = z.enum(['ephemeral', 'indexed']);
export const Category = z.enum(['ai_like_generic', 'clarity', 'repository_style', 'approved_voice', 'terminology', 'repetition', 'claim_inconsistency', 'unsupported_claim']);
export const Severity = z.enum(['major', 'minor', 'nit']);
export const ContentKind = z.enum(['heading', 'paragraph', 'button', 'link', 'label', 'placeholder', 'tooltip', 'error', 'notification', 'documentation', 'marketing', 'metadata', 'accessibility', 'css_generated', 'unknown']);
export const SourceRangeSchema = z.object({
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
}).strict().refine(v => v.endOffset >= v.startOffset && v.endLine >= v.startLine, 'Invalid range');
export type SourceRange = z.infer<typeof SourceRangeSchema>;
export const SourceSegmentSchema = z.object({
  textStart: z.number().int().nonnegative(), textEnd: z.number().int().nonnegative(),
  sourceStart: z.number().int().nonnegative(), sourceEnd: z.number().int().nonnegative(),
  encoding: z.enum(['identity', 'entity', 'escape', 'composite']),
}).strict().refine(v => v.textEnd >= v.textStart && v.sourceEnd >= v.sourceStart);
export const ContentNodeSchema = z.object({
  id: Id, repositoryId: Id, commitSha: Sha, filePath: PathSchema, blobSha: Sha,
  parser: z.string().min(1), parserVersion: z.string().min(1),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
  text: z.string().max(10000), normalizedText: z.string().max(10000), kind: ContentKind,
  sourceKind: z.string(), component: z.string().optional(), structuralPath: z.string().optional(), locale: z.string().optional(),
  dynamic: z.boolean(), visibilityConfidence: z.number().min(0).max(1), placeholders: z.array(z.string()),
  quoteStyle: z.enum(['single', 'double', 'template', 'none']).optional(), stableKey: Id,
  mappingVersion: z.literal(1), segments: z.array(SourceSegmentSchema), extractionConfigHash: Id,
  suggestionSafe: z.boolean(),
}).strict().superRefine((v, ctx) => {
  if (v.endOffset < v.startOffset || v.endLine < v.startLine) ctx.addIssue({ code: 'custom', message: 'Invalid source range' });
  let previous = 0;
  for (const segment of v.segments) {
    if (segment.textStart < previous || segment.textEnd > v.text.length || segment.sourceStart < v.startOffset || segment.sourceEnd > v.endOffset) ctx.addIssue({code:'custom',message:'Invalid source mapping'});
    previous = segment.textEnd;
  }
});
export type ContentNode = z.infer<typeof ContentNodeSchema>;
export const EvidenceSchema = z.object({
  id: Id, type: z.enum(['rule', 'repo_content', 'voice_example', 'config']), description: z.string().max(2000),
  filePath: PathSchema.optional(), line: z.number().int().positive().optional(), quote: z.string().max(10000).optional(),
  nodeId: Id.optional(), ruleId: Id.optional(), revision: z.string().max(200), contentHash: Id,
}).strict();
export type EvidenceRecord = z.infer<typeof EvidenceSchema>;
export const CandidateSchema = z.object({
  nodeId: Id, category: Category, severity: Severity, confidence: z.number().min(0).max(1),
  exactText: z.string().min(1).max(10000), explanation: z.string().min(1).max(3000),
  evidence: z.array(z.object({ id: Id, quote: z.string().max(10000).nullable() }).strict()).max(20),
  replacement: z.string().max(10000).nullable(), requiresVerification: z.boolean(),
}).strict();
export type CandidateFinding = z.infer<typeof CandidateSchema>;
export const ReviewerResponseSchema = z.object({
  candidates: z.array(CandidateSchema).max(100),
  searches: z.array(z.string().min(1).max(200)).max(3),
}).strict().refine(v => !(v.candidates.length && v.searches.length), 'Return findings OR search requests');
export const VerificationSchema = z.object({
  results: z.array(z.object({ candidateId: Id, publish: z.boolean(), confidence: z.number().min(0).max(1), correctedExplanation: z.string().max(3000).nullable(), correctedReplacement: z.string().max(10000).nullable(), reasonIfSuppressed: z.string().max(1000).nullable() }).strict()).max(100),
}).strict();
export interface ValidatedFinding extends CandidateFinding {
  fingerprint: string; node: ContentNode; evidenceRecords: EvidenceRecord[]; deterministic: boolean;
  blocking: boolean; verificationConfidence: number; suggestion?: SafeSuggestion;
}
export interface SafeSuggestion { path: string; startLine: number; endLine: number; replacement: string; sourceHash: string; headSha: string; }
export interface DiffHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; }
export interface FileDiff { oldPath: string | null; newPath: string | null; addedLines: number[]; deletedLines: number[]; hunks: DiffHunk[]; }
export interface DiffMap { repositoryId: string; baseSha: string; headSha: string; mergeBaseSha: string; files: FileDiff[]; }
export const ModelProfileSchema = z.object({ provider: ProviderId, model: z.string().min(1).max(200), credentialRef: Id.nullable(), maxInputTokens: z.number().int().min(1000).max(1000000), maxOutputTokens: z.number().int().min(100).max(100000), evaluatedLanguages: z.array(z.string().min(2).max(20)).default(['en']) }).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export const ReviewSnapshotSchema = z.object({
  version: z.literal(1), organizationId: Id, repositoryId: Id, installationId: z.number().int().positive(),
  owner: z.string().regex(/^[a-zA-Z0-9-]+$/), repository: z.string().regex(/^[a-zA-Z0-9_.-]+$/), pullNumber: z.number().int().positive(),
  baseSha: Sha, headSha: Sha, configSha: Sha, configHash: Id,
  executionMode: z.enum(['cloud','runner']), retentionMode: RetentionMode,
  reviewer: ModelProfileSchema, verifier: ModelProfileSchema, language: z.string().default('en'), allowUnevaluatedLanguage: z.boolean().default(false),
}).strict().refine(v => v.executionMode !== 'runner' || (v.reviewer.provider === 'ollama' && v.verifier.provider === 'ollama'), 'Private jobs require local models');
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;
export const RunStateSchema = z.enum(['RECEIVED','QUEUED','ACQUIRING_REPO','EXTRACTING','BUILDING_CONTEXT','REVIEWING','VERIFYING','READY_TO_PUBLISH','PUBLISHING','COMPLETE','STALE','CANCELLED','FAILED_RETRYABLE','FAILED_FINAL']);
export type RunState = z.infer<typeof RunStateSchema>;
const sequence: RunState[] = ['RECEIVED','QUEUED','ACQUIRING_REPO','EXTRACTING','BUILDING_CONTEXT','REVIEWING','VERIFYING','READY_TO_PUBLISH','PUBLISHING','COMPLETE'];
export function canTransition(from: RunState, to: RunState): boolean {
  if (['COMPLETE','STALE','CANCELLED','FAILED_FINAL'].includes(from)) return false;
  if (['STALE','CANCELLED','FAILED_FINAL','FAILED_RETRYABLE'].includes(to)) return from !== to;
  if (from === 'FAILED_RETRYABLE') return to === 'QUEUED';
  return sequence[sequence.indexOf(from) + 1] === to;
}
export const JobType = z.enum(['github.event','repository.initial_scan','repository.incremental_scan','pull_request.review','review.cloud_execute','review.runner_wait','review.publish','runner.cleanup','maintenance.reindex','maintenance.webhook_recovery','maintenance.retention']);
export const JobPayloadSchema = z.object({version:z.literal(1),organizationId:Id,repositoryId:Id,runId:Id.optional(),headSha:Sha.optional(),traceId:Id,idempotencyKey:Id}).strict();
export type JobPayload = z.infer<typeof JobPayloadSchema>;
export interface ProviderCapabilities { provider: z.infer<typeof ProviderId>; model: string; structuredOutput: boolean; embeddings: boolean; latencyMs: number; testedAt: string; }
export interface ModelResult<T> { data: T; provider: z.infer<typeof ProviderId>; model: string; requestId?: string; usage?: {inputTokens?: number; outputTokens?: number}; durationMs: number; }
export interface ModelRequest<T> { model: string; system: string; input: string; schema: z.ZodType<T>; timeoutMs: number; traceContext: {traceId:string}; signal?: AbortSignal; maxOutputTokens?: number; }
export interface EmbedRequest { model:string; input:string[]; signal?:AbortSignal; }
export interface EmbedResult { vectors:number[][]; provider:z.infer<typeof ProviderId>; model:string; dimensions:number; }
export interface ModelProvider {
  readonly id:z.infer<typeof ProviderId>;
  testConnection(model:string, signal?:AbortSignal):Promise<ProviderCapabilities>;
  listModels?(signal?:AbortSignal):Promise<string[]>;
  generateStructured<T>(args:ModelRequest<T>):Promise<ModelResult<T>>;
  embed?(args:EmbedRequest):Promise<EmbedResult>;
}
export interface RetrievalQuery { text:string; limit:number; excludeNodeId?:string; }
export interface RetrievalPort { search(query:RetrievalQuery):Promise<EvidenceRecord[]>; }
export interface SecretStore { put(organizationId:string, plaintext:string):Promise<string>; resolve(organizationId:string,reference:string):Promise<string>; revoke(organizationId:string,reference:string):Promise<void>; }
export const Classification = z.enum(['SUPPORTED_CONTENT','POSSIBLE_CONTENT','NON_CONTENT_SOURCE','GENERATED','DEPENDENCY','BINARY','TOO_LARGE','IGNORED_BY_CONFIG','UNKNOWN']);
export interface InventoryEntry { path:string; blobSha:string; mode:string; size?:number|undefined; classification:z.infer<typeof Classification>; }
export const LIMITS = Object.freeze({fileBytes:1024*1024,nodeChars:10000,parserMs:5000,parserMemoryMb:256,fileBatch:200,nodeBatch:20,nodesPerFile:2000,contextTokens:12000,outputTokens:4000,jobMs:30*60*1000,workspaceBytes:4*1024*1024*1024,subjectiveInline:5,expansionQueries:3});
export const GitHubEventSchema=z.object({
  event:z.enum(['installation','installation_repositories','pull_request','push','check_run']),action:z.string().max(100),
  installationId:z.number().int().positive(),accountId:z.number().int().positive(),accountLogin:z.string().max(100),
  repository:z.object({githubId:z.number().int().positive(),owner:z.string(),name:z.string(),defaultBranch:z.string()}).strict().nullable(),
  pull:z.object({number:z.number().int().positive(),headSha:Sha,baseSha:Sha,baseRef:z.string(),draft:z.boolean(),state:z.enum(['open','closed'])}).strict().nullable(),
  ref:z.string().max(1000).nullable(),after:Sha.nullable(),
  /** When GitHub says this happened; the only defence against reordered delivery. */
  occurredAt:z.string().datetime(),
  addedRepositoryIds:z.array(z.number().int().positive()).max(10000),removedRepositoryIds:z.array(z.number().int().positive()).max(10000),
}).strict();
export type GitHubEvent=z.infer<typeof GitHubEventSchema>;
export const RunnerCapabilitiesSchema=z.object({protocolVersion:z.literal(1),schemaVersion:z.literal('humanize-runner-v1'),version:z.string().min(1).max(50),models:z.array(z.string().min(1).max(200)).max(100),labels:z.array(z.string().max(100)).max(20),localOnly:z.literal(true)}).strict();
export const RunnerRegistrationSchema=z.object({enrollmentToken:z.string().min(32).max(200),capabilities:RunnerCapabilitiesSchema}).strict();
export const LeaseIdentitySchema=z.object({leaseId:z.string().uuid(),fence:z.number().int().positive()}).strict();
export const RunnerResultSchema=z.object({
  version:z.literal(1),leaseId:z.string().uuid(),fence:z.number().int().positive(),runId:z.string().uuid(),snapshotHash:Id,
  nodes:z.array(ContentNodeSchema).max(10000),candidates:z.array(CandidateSchema).max(100),evidence:z.array(EvidenceSchema).max(1000),
  verification:VerificationSchema,diagnostics:z.array(z.object({code:z.string().regex(/^[A-Z_]{1,100}$/),count:z.number().int().nonnegative()}).strict()).max(100),
}).strict();
export type RunnerResult=z.infer<typeof RunnerResultSchema>;
export type RunnerCapabilities=z.infer<typeof RunnerCapabilitiesSchema>;

export const DIGEST_VERSION = 'humanize-digest-1' as const;
/**
 * Versioned canonical digest. Values are schema-normalized before encoding so that a
 * PostgreSQL JSONB round trip, a parsed wire payload and an in-memory value agree, and
 * the domain label keeps digests of different payload kinds from colliding.
 */
export function domainDigest(domain:string,value:unknown):string { return fingerprint([DIGEST_VERSION,domain,value]); }
export function snapshotDigest(snapshot:unknown):string { return domainDigest('review-snapshot',ReviewSnapshotSchema.parse(snapshot)); }
export function runnerResultDigest(result:unknown):string { return domainDigest('runner-result',RunnerResultSchema.parse(result)); }
/**
 * Deterministic identity for a candidate finding (ADR-036). The control plane recomputes it
 * from the candidate itself, so a runner cannot invent a binding between a verification
 * verdict and a different candidate than the one the verifier judged.
 */
export function candidateDigest(candidate:unknown):string { return domainDigest('candidate',CandidateSchema.parse(candidate)); }

export const ResultViolation=z.enum([
  'NODE_NOT_AT_HEAD','NODE_FOREIGN_REPOSITORY','DUPLICATE_NODE_IDENTITY',
  'CANDIDATE_NODE_UNKNOWN','CANDIDATE_TEXT_NOT_IN_NODE','CANDIDATE_EVIDENCE_UNKNOWN',
  'DUPLICATE_EVIDENCE_IDENTITY','EVIDENCE_QUOTE_NOT_IN_NODE','EVIDENCE_NODE_UNKNOWN',
  'VERIFICATION_DUPLICATE','VERIFICATION_CANDIDATE_UNKNOWN',
]);
export type ResultViolation=z.infer<typeof ResultViolation>;

/**
 * Independent validation of a runner result against the lease snapshot. The runner is
 * untrusted: it may be compromised, buggy, or relaying a manipulated model response, so
 * nothing it asserts about content is taken on faith. Every check here is deterministic
 * and self-contained; revalidating source ranges against the repository requires transient
 * GitHub reads and belongs to publication.
 *
 * Returns the distinct violations found, empty when the envelope is internally consistent.
 */
export function validateRunnerResult(result:RunnerResult,snapshot:ReviewSnapshot):ResultViolation[] {
  const violations=new Set<ResultViolation>();
  const nodes=new Map<string,ContentNode>();
  for(const node of result.nodes){
    if(nodes.has(node.id))violations.add('DUPLICATE_NODE_IDENTITY');
    nodes.set(node.id,node);
    // Content extracted from any other commit or repository is stale or foreign by definition.
    if(node.commitSha!==snapshot.headSha)violations.add('NODE_NOT_AT_HEAD');
    if(node.repositoryId!==snapshot.repositoryId)violations.add('NODE_FOREIGN_REPOSITORY');
  }
  const evidence=new Map<string,EvidenceRecord>();
  for(const record of result.evidence){
    if(evidence.has(record.id))violations.add('DUPLICATE_EVIDENCE_IDENTITY');
    evidence.set(record.id,record);
    if(record.nodeId!==undefined){
      const node=nodes.get(record.nodeId);
      if(!node)violations.add('EVIDENCE_NODE_UNKNOWN');
      else if(record.quote!==undefined&&!node.text.includes(record.quote))violations.add('EVIDENCE_QUOTE_NOT_IN_NODE');
    }
  }
  for(const candidate of result.candidates){
    const node=nodes.get(candidate.nodeId);
    if(!node)violations.add('CANDIDATE_NODE_UNKNOWN');
    // A finding must quote text that actually exists in the node it points at, otherwise a
    // fabricated quote could reach a pull request as if it were the developer's own words.
    else if(!node.text.includes(candidate.exactText))violations.add('CANDIDATE_TEXT_NOT_IN_NODE');
    for(const reference of candidate.evidence)if(!evidence.has(reference.id))violations.add('CANDIDATE_EVIDENCE_UNKNOWN');
  }
  // Each verdict must name a candidate actually submitted, by its recomputed identity, so a
  // suppression cannot be rebound to a different finding than the verifier rejected.
  const identities=new Set(result.candidates.map(candidate=>candidateDigest(candidate)));
  const verified=new Set<string>();
  for(const outcome of result.verification.results){
    if(verified.has(outcome.candidateId))violations.add('VERIFICATION_DUPLICATE');
    verified.add(outcome.candidateId);
    if(!identities.has(outcome.candidateId))violations.add('VERIFICATION_CANDIDATE_UNKNOWN');
  }
  return [...violations].sort();
}
