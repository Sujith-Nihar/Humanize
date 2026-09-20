import { parse } from 'yaml';
import picomatch from 'picomatch';
import { Category,LIMITS,z } from '@humanize/domain';
import { Severity } from '@humanize/domain';
import { fingerprint } from '@humanize/shared';
import { OrganizationPolicySchema,RepositoryConfigSchema } from './schema.js';
import type { OrganizationPolicy,RepositoryConfig } from './schema.js';

export * from './schema.js';

/** A configuration file is small by nature; anything larger is hostile or a mistake. */
export const MAX_CONFIG_BYTES=64*1024;
export const CONFIG_PATH='.humanize.yml';

export type ConfigViolation='CONFIG_TOO_LARGE'|'CONFIG_UNPARSEABLE'|'CONFIG_NOT_A_MAPPING'|'CONFIG_SCHEMA_INVALID';

export interface EffectiveConfig {
  readonly drafts:boolean;
  readonly categories:Readonly<Record<z.infer<typeof Category>,boolean>>;
  readonly maxSubjectiveInline:number;
  readonly minimumSeverity:z.infer<typeof Severity>;
  readonly include:readonly string[];
  readonly exclude:readonly string[];
  readonly visibleProps:readonly string[];
  readonly visibleCalls:readonly string[];
  readonly approvedVoiceSources:readonly string[];
  readonly tone:readonly string[];
  readonly avoid:readonly string[];
  readonly terminology:Readonly<Record<string,string>>;
  readonly blockingRules:readonly {type:'forbidden_phrase';phrase:string}[];
  readonly retentionMode:OrganizationPolicy['retentionMode'];
  readonly executionMode:OrganizationPolicy['executionMode'];
  readonly reviewer:OrganizationPolicy['reviewer'];
  readonly verifier:OrganizationPolicy['verifier'];
  readonly digest:string;
}

export interface LoadedConfig { config:RepositoryConfig|null; violations:ConfigViolation[]; }

/**
 * Parses `.humanize.yml` from the trusted base revision. The document is untrusted input:
 * alias expansion is capped so an alias bomb cannot exhaust memory, custom tags are refused,
 * and the result must be a plain mapping. A file that fails any check yields no repository
 * configuration, so resolution falls back to administrator policy and defaults — review
 * still runs, because a malformed file must never silently switch reviewing off.
 */
export function loadRepositoryConfig(source:string):LoadedConfig {
  if(Buffer.byteLength(source,'utf8')>MAX_CONFIG_BYTES)return {config:null,violations:['CONFIG_TOO_LARGE']};
  let document:unknown;
  try{document=parse(source,{maxAliasCount:100,customTags:[],merge:false,strict:true});}
  catch{return {config:null,violations:['CONFIG_UNPARSEABLE']};}
  if(document===null||document===undefined)return {config:null,violations:[]};
  if(typeof document!=='object'||Array.isArray(document))return {config:null,violations:['CONFIG_NOT_A_MAPPING']};
  const parsed=RepositoryConfigSchema.safeParse(document);
  return parsed.success?{config:parsed.data,violations:[]}:{config:null,violations:['CONFIG_SCHEMA_INVALID']};
}

const DEFAULT_EXCLUDE=['**/*.test.*','**/*.spec.*','**/*.stories.*','dist/**','build/**','coverage/**'];

function layer(base:RepositoryConfig|null,override:RepositoryConfig|undefined):RepositoryConfig {
  return {...(base??{version:1}),...(override??{}),version:1};
}

/**
 * Applies the approved precedence: hard invariants, administrator policy, trusted-base
 * repository configuration, path-specific configuration, then defaults. Administrator-only
 * values are taken from policy unconditionally — they are never read from `repository`,
 * whatever it contains — and repository choices are clamped by the administrator's caps.
 */
export function resolveConfiguration(input:{policy:OrganizationPolicy;repository?:RepositoryConfig|null|undefined;path?:string|undefined}):EffectiveConfig {
  const policy=OrganizationPolicySchema.parse(input.policy);
  const base=input.repository??null;
  const scoped=input.path===undefined?undefined
    :base?.overrides?.find(override=>picomatch.isMatch(input.path!,[...override.paths],{dot:true}));
  const merged=layer(base,scoped as RepositoryConfig|undefined);

  const permitted=new Set(policy.permittedCategories);
  const categories=Object.fromEntries(Category.options.map(category=>{
    const requested=merged.review?.categories?.[category];
    // A repository may switch a category off, but only the administrator can switch one on.
    return [category,permitted.has(category)&&requested!==false];
  })) as Record<z.infer<typeof Category>,boolean>;

  const requestedInline=merged.comments?.max_subjective_inline;
  const cap=Math.min(policy.maxSubjectiveInline,LIMITS.subjectiveInline);
  const blocking=[...policy.requiredBlockingRules,...(merged.blocking_rules??[])]
    .filter((rule,index,all)=>all.findIndex(other=>other.phrase===rule.phrase)===index);

  const resolved={
    drafts:policy.allowDrafts&&merged.review?.drafts===true,
    categories,
    maxSubjectiveInline:requestedInline===undefined?cap:Math.min(requestedInline,cap),
    minimumSeverity:merged.comments?.minimum_severity??'minor',
    include:merged.include??[],
    exclude:merged.exclude??DEFAULT_EXCLUDE,
    visibleProps:merged.visible_props??[],
    visibleCalls:merged.visible_calls??[],
    approvedVoiceSources:merged.voice?.approved_sources??[],
    tone:merged.voice?.tone??[],
    avoid:merged.voice?.avoid??[],
    terminology:merged.terminology?.prefer??{},
    blockingRules:blocking,
    retentionMode:policy.retentionMode,
    executionMode:policy.executionMode,
    reviewer:policy.reviewer,
    verifier:policy.verifier,
  };
  return Object.freeze({...resolved,digest:fingerprint(resolved)});
}
