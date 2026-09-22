import { expect,it } from 'vitest';
import type { CandidateFinding,EvidenceRecord } from '@humanize/domain';
import { applyVerification,validateCandidate } from './src/core.js';
import type { ReviewableUnit } from './src/core.js';

/**
 * These tests construct only a `ReviewableUnit` — never a `ContentNode` or `ReviewSnapshot` —
 * to prove the extracted common core genuinely needs no repository identity, no commit SHA, no
 * blob SHA and no file path to do its job. The GitHub path's own behavior is protected by the
 * existing `reviewNodes` tests in `pipeline.test.ts`, which exercise this same logic end to end
 * and must keep passing unchanged; these tests cover the core in isolation, which nothing
 * exercised before this extraction.
 */
const unit:ReviewableUnit={id:'unit-1',text:'Unlock unprecedented potential with our cutting-edge platform.',placeholders:[]};
const candidate=(overrides:Partial<CandidateFinding>={}):CandidateFinding=>({
  nodeId:'unit-1',category:'ai_like_generic',severity:'minor',confidence:0.95,
  exactText:'Unlock unprecedented potential',explanation:'Broad promotional wording with little product-specific information',
  evidence:[{id:'evidence-1',quote:null}],replacement:null,requiresVerification:true,...overrides,
});
const evidence=new Map<string,EvidenceRecord>([['evidence-1',{id:'evidence-1',type:'repo_content',description:'x',revision:'r',contentHash:'h'}]]);
const routed=['ai_like_generic'] as const;

it('accepts a candidate that names the unit, quotes it verbatim, stays routed and cites supplied evidence',()=>{
  expect(validateCandidate(candidate(),unit,routed,evidence)).toBeNull();
});

it('rejects a candidate naming a different unit',()=>{
  expect(validateCandidate(candidate({nodeId:'unit-2'}),unit,routed,evidence)).toBe('foreign_node');
});

it('rejects a quotation the unit text does not contain',()=>{
  expect(validateCandidate(candidate({exactText:'wording the author never wrote'}),unit,routed,evidence)).toBe('text_not_in_node');
});

it('rejects a category the router did not select',()=>{
  expect(validateCandidate(candidate({category:'clarity'}),unit,routed,evidence)).toBe('category_not_routed');
});

it('rejects a candidate citing evidence that was never supplied',()=>{
  expect(validateCandidate(candidate({evidence:[{id:'invented',quote:null}]}),unit,routed,evidence)).toBe('evidence_not_supplied');
});

const verdict=(overrides:Partial<{candidateId:string;publish:boolean;confidence:number;correctedExplanation:string|null;correctedReplacement:string|null;reasonIfSuppressed:string|null}> ={})=>({
  candidateId:'c1',publish:true,confidence:0.95,correctedExplanation:null,correctedReplacement:null,reasonIfSuppressed:null,...overrides,
});
const SYSTEM='Never describe your own checking. Address the author directly.';

it('leaves the reviewer wording untouched when the verifier offers no correction',()=>{
  const applied=applyVerification(candidate(),verdict(),SYSTEM);
  expect(applied).toEqual({explanation:candidate().explanation,replacement:null,notAuthorFacing:false,placeholderDropped:false});
});

it('applies a sound, author-facing correction',()=>{
  const applied=applyVerification(candidate({exactText:'Hello {name}',replacement:null}),
    verdict({correctedExplanation:'This phrase promises a lot and says nothing specific.',correctedReplacement:'Hi {name}'}),SYSTEM);
  expect(applied).toMatchObject({explanation:'This phrase promises a lot and says nothing specific.',replacement:'Hi {name}',placeholderDropped:false});
});

it('discards a correction that echoes the verifier system prompt instead of addressing the author',()=>{
  const applied=applyVerification(candidate(),verdict({correctedExplanation:'Never describe your own checking. Address the author directly. Extra words to pass the length floor.'}),SYSTEM);
  expect(applied.notAuthorFacing).toBe(true);
  expect(applied.explanation).toBe(candidate().explanation);
});

it('discards a corrected replacement that drops a placeholder the original text carried',()=>{
  const applied=applyVerification(candidate({exactText:'Hello {name}, you have {{count}} alerts',replacement:'Hi {name}, you have {{count}} alerts'}),
    verdict({correctedReplacement:'Hi there, you have alerts'}),SYSTEM);
  expect(applied.placeholderDropped).toBe(true);
  expect(applied.replacement).toBe('Hi {name}, you have {{count}} alerts');
});

it('accepts a corrected replacement that preserves every placeholder, in any order since they are named',()=>{
  const applied=applyVerification(candidate({exactText:'Hello {name}, you have {{count}} alerts',replacement:null}),
    verdict({correctedReplacement:'{{count}} alerts are waiting, {name}'}),SYSTEM);
  expect(applied.placeholderDropped).toBe(false);
  expect(applied.replacement).toBe('{{count}} alerts are waiting, {name}');
});
