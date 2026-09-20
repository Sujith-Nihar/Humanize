import { expect,it } from 'vitest';
import { candidateDigest,validateRunnerResult } from './src/index.js';
import type { ContentNode,EvidenceRecord,ReviewSnapshot,RunnerResult } from './src/index.js';

const headSha='b'.repeat(40);
const profile={provider:'ollama' as const,model:'fixture',credentialRef:null,maxInputTokens:12000,maxOutputTokens:4000,evaluatedLanguages:['en']};
const snapshot:ReviewSnapshot={version:1,organizationId:'org',repositoryId:'repo',installationId:7,owner:'acme',repository:'site',pullNumber:1,baseSha:'a'.repeat(40),headSha,configSha:'c'.repeat(40),configHash:'config',executionMode:'runner',retentionMode:'ephemeral',reviewer:profile,verifier:profile,language:'en',allowUnevaluatedLanguage:false};
const node:ContentNode={id:'node-1',repositoryId:'repo',commitSha:headSha,filePath:'app/page.tsx',blobSha:'d'.repeat(40),parser:'babel',parserVersion:'1',startLine:1,endLine:1,startOffset:0,endOffset:44,text:'Unlock unprecedented potential with our tool',normalizedText:'unlock unprecedented potential with our tool',kind:'heading',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:'stable-1',mappingVersion:1,segments:[],extractionConfigHash:'config-hash',suggestionSafe:true};
const evidence:EvidenceRecord={id:'evidence-1',type:'repo_content',description:'Existing headings are capability focused',revision:headSha,contentHash:'hash-1',nodeId:'node-1',quote:'Unlock unprecedented potential'};
const candidate={nodeId:'node-1',category:'ai_like_generic' as const,severity:'minor' as const,confidence:0.9,exactText:'Unlock unprecedented potential',explanation:'Broad promotional wording',evidence:[{id:'evidence-1',quote:null}],replacement:null,requiresVerification:true};
const base:RunnerResult={version:1,leaseId:'11111111-1111-4111-8111-111111111111',fence:1,runId:'22222222-2222-4222-8222-222222222222',snapshotHash:'digest',nodes:[node],candidates:[candidate],evidence:[evidence],verification:{results:[{candidateId:candidateDigest(candidate),publish:true,confidence:0.9,correctedExplanation:null,correctedReplacement:null,reasonIfSuppressed:null}]},diagnostics:[]};

it('accepts an internally consistent result', () => {
  expect(validateRunnerResult(base,snapshot)).toEqual([]);
});

it('rejects content that was not extracted at the reviewed commit or repository', () => {
  expect(validateRunnerResult({...base,nodes:[{...node,commitSha:'f'.repeat(40)}]},snapshot)).toContain('NODE_NOT_AT_HEAD');
  expect(validateRunnerResult({...base,nodes:[{...node,repositoryId:'other'}]},snapshot)).toContain('NODE_FOREIGN_REPOSITORY');
});

// Mutating a candidate changes its identity (ADR-036), so cases that isolate a candidate or
// evidence violation carry no verdicts of their own.
const unverified={...base,verification:{results:[]}};

it('rejects a fabricated quote that does not appear in the node it points at', () => {
  const fabricated={...unverified,candidates:[{...candidate,exactText:'wording the developer never wrote'}]};
  expect(validateRunnerResult(fabricated,snapshot)).toEqual(['CANDIDATE_TEXT_NOT_IN_NODE']);
  const fabricatedEvidence={...unverified,evidence:[{...evidence,quote:'a sentence that is not in the file'}]};
  expect(validateRunnerResult(fabricatedEvidence,snapshot)).toEqual(['EVIDENCE_QUOTE_NOT_IN_NODE']);
});

it('rejects findings and evidence that reference nothing submitted', () => {
  expect(validateRunnerResult({...unverified,candidates:[{...candidate,nodeId:'missing'}]},snapshot)).toEqual(['CANDIDATE_NODE_UNKNOWN']);
  expect(validateRunnerResult({...unverified,candidates:[{...candidate,evidence:[{id:'missing',quote:null}]}]},snapshot)).toEqual(['CANDIDATE_EVIDENCE_UNKNOWN']);
  expect(validateRunnerResult({...unverified,evidence:[{...evidence,nodeId:'missing'}]},snapshot)).toEqual(['EVIDENCE_NODE_UNKNOWN']);
});

it('rejects duplicate identities and unmatched verification', () => {
  expect(validateRunnerResult({...base,nodes:[node,node]},snapshot)).toContain('DUPLICATE_NODE_IDENTITY');
  expect(validateRunnerResult({...base,evidence:[evidence,evidence]},snapshot)).toContain('DUPLICATE_EVIDENCE_IDENTITY');
  const repeated={...base,verification:{results:[base.verification.results[0]!,base.verification.results[0]!]}};
  expect(validateRunnerResult(repeated,snapshot)).toContain('VERIFICATION_DUPLICATE');
  const unknown={...base,verification:{results:[{...base.verification.results[0]!,candidateId:'not-a-candidate'}]}};
  expect(validateRunnerResult(unknown,snapshot)).toContain('VERIFICATION_CANDIDATE_UNKNOWN');
  // A verdict cannot be rebound to a different candidate than the one it judged.
  const rebound={...base,candidates:[{...candidate,severity:'major' as const}]};
  expect(validateRunnerResult(rebound,snapshot)).toContain('VERIFICATION_CANDIDATE_UNKNOWN');
});

it('reports every distinct violation once, in a stable order', () => {
  const broken={
    ...unverified,
    nodes:[{...node,commitSha:'f'.repeat(40)},{...node,commitSha:'f'.repeat(40)}],
    candidates:[{...base.candidates[0]!,exactText:'never written'}],
  };
  // Each distinct problem is named once, sorted, however many times it occurs.
  expect(validateRunnerResult(broken,snapshot)).toEqual(['CANDIDATE_TEXT_NOT_IN_NODE','DUPLICATE_NODE_IDENTITY','NODE_NOT_AT_HEAD']);
});
