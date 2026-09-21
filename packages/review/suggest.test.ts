import { expect,it } from 'vitest';
import { attachSuggestions,informationLost } from './src/index.js';
import type { ContentNode,DiffMap,ValidatedFinding } from '@humanize/domain';

const SOURCE=`export const Hero = () => (\n  <h1>Scientifically Engineered Sound — Designed for the Mind</h1>\n);\n`;
const TEXT='Scientifically Engineered Sound — Designed for the Mind';
const headSha='c'.repeat(40);

const node=(overrides:Partial<ContentNode>={}):ContentNode=>({
  id:'n1',repositoryId:'r',commitSha:headSha,filePath:'Hero.tsx',blobSha:'b'.repeat(40),
  parser:'babel',parserVersion:'1.0.0',startLine:2,endLine:2,
  startOffset:SOURCE.indexOf(TEXT),endOffset:SOURCE.indexOf(TEXT)+TEXT.length,
  text:TEXT,normalizedText:TEXT,kind:'heading',sourceKind:'jsx_text',dynamic:false,visibilityConfidence:1,
  placeholders:[],stableKey:'k',mappingVersion:1,
  segments:[{textStart:0,textEnd:TEXT.length,sourceStart:SOURCE.indexOf(TEXT),sourceEnd:SOURCE.indexOf(TEXT)+TEXT.length,encoding:'identity'}],
  extractionConfigHash:'cfg',suggestionSafe:true,...overrides,
});
const finding=(replacement:string|null,overrides:Partial<ContentNode>={}):ValidatedFinding=>({
  nodeId:'n1',category:'ai_like_generic',severity:'minor',confidence:1,exactText:TEXT,
  explanation:'tagline restates the heading',evidence:[],replacement,requiresVerification:false,
  fingerprint:'f1',node:node(overrides),evidenceRecords:[],deterministic:true,blocking:false,verificationConfidence:1,
});
const diff:DiffMap={repositoryId:'r',baseSha:'a'.repeat(40),headSha,mergeBaseSha:'a'.repeat(40),
  files:[{oldPath:'Hero.tsx',newPath:'Hero.tsx',addedLines:[2],deletedLines:[],hunks:[{oldStart:1,oldCount:3,newStart:1,newCount:3}]}]};

it('attaches a one-click fix it has proven against the file itself',async()=>{
  const findings=[finding('Scientifically Engineered Sound')];
  const outcome=await attachSuggestions(findings,diff,headSha,async()=>SOURCE);
  expect(outcome.attached).toBe(1);
  expect(findings[0]!.suggestion?.replacement).toContain('Scientifically Engineered Sound</h1>');
  expect(findings[0]!.suggestion?.replacement).not.toContain('Designed for the Mind');
});

it('refuses a patch that would change what the file does',async()=>{
  // Valid syntax is not proof of a safe patch: this opens a JSX expression from prose.
  const findings=[finding('{dangerouslyRun()}')];
  const outcome=await attachSuggestions(findings,diff,headSha,async()=>SOURCE);
  expect(outcome.attached).toBe(0);
  expect(findings[0]!.suggestion).toBeUndefined();
  expect(Object.keys(outcome.refused).length).toBeGreaterThan(0);
});

it('refuses when the file cannot be read, rather than guessing at it',async()=>{
  const findings=[finding('Scientifically Engineered Sound')];
  const outcome=await attachSuggestions(findings,diff,headSha,async()=>null);
  expect(outcome).toEqual({attached:0,refused:{SOURCE_UNAVAILABLE:1}});
});

it('leaves a comment-only finding alone',async()=>{
  let reads=0;
  const outcome=await attachSuggestions([finding(null)],diff,headSha,async()=>{reads++;return SOURCE;});
  expect(outcome.attached).toBe(0);
  // Nothing is fetched for a finding that proposes no replacement.
  expect(reads).toBe(0);
});

it('refuses a rewrite that drops a fact the author stated',async()=>{
  // A suggestion changes how something is written, never what it says.
  expect(informationLost('Reviews complete in 30 seconds on NeuroRhythms.','Reviews complete quickly.'))
    .toEqual(['30','NeuroRhythms']);
  expect(informationLost('Built for the JVM and the CLR.','Built for the JVM.')).toEqual(['CLR']);
  // Rephrasing that keeps every fact is allowed through.
  expect(informationLost('NeuroRhythms cuts review time by 40%.','NeuroRhythms reviews 40% faster.')).toEqual([]);
  // Title case is not treated as proper nouns, or every heading would be unrewritable.
  expect(informationLost('It Is Not Just Music','It is music')).toEqual([]);
});

it('does not build a patch when information would be lost',async()=>{
  const findings=[finding('Scientifically Engineered Sound')];
  findings[0]!.node.text='Scientifically Engineered Sound — Built for ADHD';
  const outcome=await attachSuggestions(findings,diff,headSha,async()=>SOURCE);
  expect(outcome).toEqual({attached:0,refused:{INFORMATION_LOST:1}});
});
