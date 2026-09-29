import { expect,it } from 'vitest';
import { DEFAULT_REVIEW_SCOPE } from '@humanize/domain';
import type { ContentNode,EvidenceRecord,ReviewResult,ReviewSnapshot } from '@humanize/domain';
import { findingsFromResult,planPublication } from './src/index.js';
import type { NodeSignal } from './src/index.js';

const headSha='b'.repeat(40);
const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const snapshot:ReviewSnapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,
  baseSha:'a'.repeat(40),headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',
  reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false,review:DEFAULT_REVIEW_SCOPE};
const text='Our service is 100% secure for everyone.';
const node:ContentNode={id:'node-1',repositoryId:'repo',commitSha:headSha,filePath:'docs/guide.md',blobSha:'d'.repeat(40),parser:'markdown',parserVersion:'1',
  startLine:1,endLine:1,startOffset:0,endOffset:text.length,text,normalizedText:text.toLowerCase(),kind:'paragraph',sourceKind:'markdown_paragraph',
  dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config-hash',suggestionSafe:true};
const ruleEvidence:EvidenceRecord={id:'rule-evidence',type:'rule',description:'Prohibited phrase: 100% secure',revision:headSha,contentHash:'h',nodeId:'node-1',quote:'100% secure'};
const forbidden:NodeSignal={ruleId:'forbidden:100% secure',description:'Prohibited phrase: 100% secure',category:'terminology',severity:'major',
  start:15,end:26,matchedText:'100% secure',blocking:true,evidence:ruleEvidence};
const result=(overrides:Partial<ReviewResult>={}):ReviewResult=>({version:1,runId:'22222222-2222-4222-8222-222222222222',snapshotHash:'digest',
  nodes:[node],contextNodes:[],candidates:[],evidence:[],verification:{results:[]},diagnostics:[],...overrides});
const asCandidate={nodeId:'node-1',category:'terminology' as const,severity:'major' as const,confidence:1,exactText:'100% secure',
  explanation:'Prohibited phrase: 100% secure',evidence:[{id:'rule-evidence',quote:'100% secure'}],replacement:null,requiresVerification:false};

it('recomputes a blocking finding from the reviewed text, whatever the result says', () => {
  // A runner that leaves the rule finding out cannot suppress it.
  const findings=findingsFromResult(result(),snapshot,()=>[forbidden]);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({exactText:'100% secure',blocking:true,deterministic:true,confidence:1});
});

it('keeps one finding when the executor also reported the rule finding as a candidate', () => {
  const findings=findingsFromResult(result({candidates:[asCandidate]}),snapshot,()=>[forbidden]);
  expect(findings.map(finding=>[finding.exactText,finding.blocking])).toEqual([['100% secure',true]]);
});

it('never lets a result promote its own candidate to blocking', () => {
  // With no rule configured, the same candidate is just an observation: nothing in the
  // envelope can make it blocking, so a compromised runner cannot fail a check run.
  const findings=findingsFromResult(result({candidates:[asCandidate]}),snapshot,()=>[]);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({blocking:false,deterministic:false});
});

it('recomputes nothing for content outside the reviewed commit', () => {
  const stale=result({nodes:[{...node,commitSha:'f'.repeat(40)}]});
  expect(findingsFromResult(stale,snapshot,()=>[forbidden])).toEqual([]);
});

it('exempts recomputed rule findings from the subjective budget and the nit filter', () => {
  // Deterministic findings were published as model findings before, so a rule nit was dropped
  // and rule findings consumed the five inline slots meant for subjective ones.
  const nit:NodeSignal={...forbidden,ruleId:'standalone:nit',blocking:false,standalone:true,severity:'nit',category:'ai_like_generic'};
  const plan=planPublication(findingsFromResult(result(),snapshot,()=>[nit]),{maxSubjectiveInline:0});
  expect(plan.inline.map(finding=>finding.severity)).toEqual(['nit']);
});
