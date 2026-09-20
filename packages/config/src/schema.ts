import { Category,LIMITS,RetentionMode,Severity,ProviderId,z } from '@humanize/domain';

/** Glob patterns are matched, never executed; they may not escape the repository root. */
const Glob=z.string().min(1).max(500).refine(v=>!v.startsWith('/')&&!v.includes('..')&&!v.includes('\0'),'Unsafe pattern');
const Phrase=z.string().min(1).max(200);

export const BlockingRuleSchema=z.object({type:z.literal('forbidden_phrase'),phrase:Phrase}).strict();

const overridable={
  review:z.object({drafts:z.boolean(),categories:z.partialRecord(Category,z.boolean())}).partial().strict(),
  comments:z.object({max_subjective_inline:z.number().int().min(0).max(50),minimum_severity:Severity}).partial().strict(),
  include:z.array(Glob).max(200),
  exclude:z.array(Glob).max(200),
  visible_props:z.array(z.string().min(1).max(100)).max(200),
  visible_calls:z.array(z.string().min(1).max(100)).max(200),
  voice:z.object({approved_sources:z.array(Glob).max(100),tone:z.array(Phrase).max(20),avoid:z.array(Phrase).max(200)}).partial().strict(),
  terminology:z.object({prefer:z.record(Phrase,Phrase)}).partial().strict(),
  blocking_rules:z.array(BlockingRuleSchema).max(100),
};

/** A path-scoped override may narrow the same fields, and nothing else. */
export const PathOverrideSchema=z.object({paths:z.array(Glob).min(1).max(100),...overridable}).partial().required({paths:true}).strict();

/**
 * The repository file is data only. It is strict, so an administrator-only key such as a
 * provider, model, credential, endpoint, execution mode or retention mode is rejected
 * outright rather than quietly ignored: silently dropping it would let a repository appear
 * to control something it must never control.
 */
export const RepositoryConfigSchema=z.object({version:z.literal(1),...overridable,overrides:z.array(PathOverrideSchema).max(50)}).partial().required({version:true}).strict();
export type RepositoryConfig=z.infer<typeof RepositoryConfigSchema>;

/** Administrator-owned settings. These never come from repository content. */
export const OrganizationPolicySchema=z.object({
  retentionMode:RetentionMode,
  executionMode:z.enum(['cloud','runner']),
  reviewer:z.object({provider:ProviderId,model:z.string().min(1).max(200)}).strict(),
  verifier:z.object({provider:ProviderId,model:z.string().min(1).max(200)}).strict(),
  allowDrafts:z.boolean().default(false),
  maxSubjectiveInline:z.number().int().min(0).max(50).default(LIMITS.subjectiveInline),
  // A category absent from this list cannot be switched on by a repository.
  permittedCategories:z.array(Category).default([...Category.options]),
  requiredBlockingRules:z.array(BlockingRuleSchema).max(100).default([]),
}).strict();
export type OrganizationPolicy=z.infer<typeof OrganizationPolicySchema>;
