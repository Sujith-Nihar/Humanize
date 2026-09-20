import { expect,it } from 'vitest';
import { loadRepositoryConfig,resolveConfiguration,MAX_CONFIG_BYTES } from './src/index.js';
import type { OrganizationPolicy } from './src/index.js';

const policy:OrganizationPolicy={
  retentionMode:'ephemeral',executionMode:'runner',
  reviewer:{provider:'ollama',model:'local-reviewer'},verifier:{provider:'ollama',model:'local-verifier'},
  allowDrafts:false,maxSubjectiveInline:5,
  permittedCategories:['ai_like_generic','clarity','terminology'],requiredBlockingRules:[{type:'forbidden_phrase',phrase:'100% secure'}],
};
const load=(yaml:string)=>loadRepositoryConfig(yaml);
const resolve=(yaml:string,path?:string)=>resolveConfiguration({policy,repository:load(yaml).config,path});

it('reads the documented repository file', () => {
  const {config,violations}=load(`version: 1
review:
  drafts: true
  categories:
    clarity: false
comments:
  max_subjective_inline: 3
  minimum_severity: major
include:
  - "app/**"
exclude:
  - "dist/**"
visible_props: [headline]
visible_calls: [toast]
voice:
  approved_sources: ["docs/brand/**"]
  avoid: [cutting-edge]
terminology:
  prefer:
    "AI tool": "AI application"
blocking_rules:
  - type: forbidden_phrase
    phrase: "bank-grade"
`);
  expect(violations).toEqual([]);
  expect(config).toMatchObject({version:1,include:['app/**'],visible_calls:['toast']});
});

it('refuses administrator-only settings in repository content instead of ignoring them', () => {
  // Each of these would let a repository choose where its content is sent or how long it is kept.
  for(const field of [
    'models:\n  reviewer:\n    provider: openai',
    'provider: openai',
    'retention_mode: indexed',
    'execution_mode: cloud',
    'ollama_base_url: http://attacker.example',
    'credentials:\n  openai: sk-test',
  ]){
    const {config,violations}=load(`version: 1\n${field}\n`);
    expect(violations).toEqual(['CONFIG_SCHEMA_INVALID']);
    expect(config).toBeNull();
  }
});

it('takes every administrator-only value from policy whatever the repository says', () => {
  const effective=resolve('version: 1\n');
  expect(effective.retentionMode).toBe('ephemeral');
  expect(effective.executionMode).toBe('runner');
  expect(effective.reviewer).toEqual({provider:'ollama',model:'local-reviewer'});
  expect(effective.verifier).toEqual({provider:'ollama',model:'local-verifier'});
});

it('lets a repository narrow review but never widen it', () => {
  const effective=resolve(`version: 1
review:
  drafts: true
  categories:
    clarity: false
    repetition: true
comments:
  max_subjective_inline: 40
`);
  // Drafts stay off because the administrator disallows them.
  expect(effective.drafts).toBe(false);
  // A permitted category can be switched off, but one the administrator withheld stays off.
  expect(effective.categories.clarity).toBe(false);
  expect(effective.categories.ai_like_generic).toBe(true);
  expect(effective.categories.repetition).toBe(false);
  // The requested budget is clamped to the administrator cap.
  expect(effective.maxSubjectiveInline).toBe(5);
  expect(resolve('version: 1\ncomments:\n  max_subjective_inline: 2\n').maxSubjectiveInline).toBe(2);
});

it('keeps administrator blocking rules even when the repository omits them', () => {
  const effective=resolve('version: 1\nblocking_rules:\n  - type: forbidden_phrase\n    phrase: "bank-grade"\n');
  expect(effective.blockingRules).toEqual([{type:'forbidden_phrase',phrase:'100% secure'},{type:'forbidden_phrase',phrase:'bank-grade'}]);
  expect(resolve('version: 1\n').blockingRules).toEqual([{type:'forbidden_phrase',phrase:'100% secure'}]);
});

it('applies a path override only to matching paths and only to overridable fields', () => {
  const yaml=`version: 1
comments:
  max_subjective_inline: 4
overrides:
  - paths: ["docs/**"]
    comments:
      minimum_severity: major
`;
  expect(resolve(yaml,'docs/guide.md').minimumSeverity).toBe('major');
  expect(resolve(yaml,'app/page.tsx').minimumSeverity).toBe('minor');
  // An override carrying an administrator-only field invalidates the file rather than applying.
  expect(load(`version: 1\noverrides:\n  - paths: ["docs/**"]\n    retention_mode: indexed\n`).violations).toEqual(['CONFIG_SCHEMA_INVALID']);
});

it('fails closed to policy defaults so a malformed file cannot switch reviewing off', () => {
  for(const [source,violation] of [
    ['version: 1\n  bad indent: [',  'CONFIG_UNPARSEABLE'],
    ['- just\n- a list\n','CONFIG_NOT_A_MAPPING'],
    ['version: 2\n','CONFIG_SCHEMA_INVALID'],
    ['x'.repeat(MAX_CONFIG_BYTES+1),'CONFIG_TOO_LARGE'],
  ] as const){
    expect(load(source).violations).toEqual([violation]);
  }
  // Review still happens on the administrator's terms.
  const effective=resolveConfiguration({policy,repository:load('- broken\n').config});
  expect(effective.categories.ai_like_generic).toBe(true);
  expect(effective.maxSubjectiveInline).toBe(5);
});

it('survives hostile YAML', () => {
  const bomb=`version: 1\na: &a ["x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n`;
  expect(load(bomb).config).toBeNull();
  // A custom tag must not construct anything.
  expect(load('version: 1\ninclude: !!js/function "function(){}"\n').config).toBeNull();
  expect(load('version: 1\ninclude: ["/etc/passwd"]\n').violations).toEqual(['CONFIG_SCHEMA_INVALID']);
  expect(load('version: 1\ninclude: ["../../../etc/passwd"]\n').violations).toEqual(['CONFIG_SCHEMA_INVALID']);
});

it('produces a stable digest that changes with the effective outcome', () => {
  expect(resolve('version: 1\n').digest).toBe(resolve('version: 1\n').digest);
  expect(resolve('version: 1\ninclude: ["app/**"]\n').digest).not.toBe(resolve('version: 1\n').digest);
  // Repository text that cannot change the outcome cannot change the digest either.
  expect(resolve('version: 1\nreview:\n  drafts: true\n').digest).toBe(resolve('version: 1\n').digest);
});
