import { expect, it } from 'vitest';
import { evaluateRules } from '@humanize/rules';
import type { ContentNode } from '@humanize/domain';
import { REVIEW_GOLD } from './gold.js';

/**
 * Measures the deterministic layer alone, with no model involved.
 *
 * A standalone rule publishes a finding on its own (ADR-037), so its precision is decided
 * entirely here: whatever it fires on reaches a pull request whether or not any model agrees.
 * That makes a false positive on a `comment: false` case a release-blocking defect rather than
 * a tuning preference, and it makes this gate cheap enough to run in the default lane.
 */
const node = (id: string, kind: ContentNode['kind'], text: string): ContentNode => ({
  id, repositoryId: 'r', commitSha: 'a'.repeat(40), filePath: 'page.tsx', blobSha: 'b'.repeat(40),
  parser: 'babel', parserVersion: '1.0.0', startLine: 1, endLine: 1, startOffset: 0, endOffset: text.length,
  text, normalizedText: text, kind, sourceKind: 'jsx_text', dynamic: false, visibilityConfidence: 1,
  placeholders: [], stableKey: id, mappingVersion: 1,
  segments: [{ textStart: 0, textEnd: text.length, sourceStart: 0, sourceEnd: text.length, encoding: 'identity' }],
  extractionConfigHash: 'cfg', suggestionSafe: true,
});

const standaloneSignals = (text: string, kind: ContentNode['kind'] = 'marketing') =>
  evaluateRules(node('n', kind, text), {}).filter(signal => signal.standalone === true);

it('never raises a standalone finding on content labelled do-not-comment', () => {
  const wrong = REVIEW_GOLD.filter(c => !c.comment)
    .map(c => ({ id: c.id, fired: standaloneSignals(c.text, c.kind).map(s => s.ruleId) }))
    .filter(entry => entry.fired.length > 0);
  // Named individually, because a bare count tells whoever broke this nothing.
  expect(wrong, `standalone rules fired on sound writing: ${JSON.stringify(wrong)}`).toEqual([]);
});

it('observes every structural construction, and publishes only the corroborated ones',()=>{
  // All five are seen. Whether one is published depends on corroboration, because no single
  // marker is trustworthy: "not X, it's Y" predates the machines and the em dash was learned
  // from well-edited human prose.
  const structural=['negation-reframe-hero','negation-reframe-inline','negation-reframe-nojust',
    'formulaic-opener-world','tagline-appositive'];
  const unobserved=structural.filter(id=>{
    const testCase=REVIEW_GOLD.find(c=>c.id===id)!;
    return !evaluateRules(node('n',testCase.kind,testCase.text),{}).some(s=>s.ruleId.startsWith('construction:'));
  });
  expect(unobserved,`constructions not even observed: ${unobserved.join(', ')}`).toEqual([]);

  // Corroborated: a construction plus an independent family in the same passage.
  for(const id of ['negation-reframe-hero','negation-reframe-inline','tagline-appositive']){
    const testCase=REVIEW_GOLD.find(c=>c.id===id)!;
    expect(standaloneSignals(testCase.text,testCase.kind).length,id).toBeGreaterThan(0);
  }
  // Uncorroborated: observed, held back, and left to the model to judge. Recording this
  // deliberately, so a later change that publishes them is a visible decision.
  for(const id of ['negation-reframe-nojust','formulaic-opener-world']){
    const testCase=REVIEW_GOLD.find(c=>c.id===id)!;
    expect(standaloneSignals(testCase.text,testCase.kind),id).toHaveLength(0);
  }
});

it('measures deterministic coverage across the whole corpus', () => {
  const positives = REVIEW_GOLD.filter(c => c.comment);
  const negatives = REVIEW_GOLD.filter(c => !c.comment);
  const caught = positives.filter(c => standaloneSignals(c.text, c.kind).length > 0);
  const falsePositives = negatives.filter(c => standaloneSignals(c.text, c.kind).length > 0);

  // Precision of the deterministic layer must be perfect: it answers to no verifier.
  expect(falsePositives).toHaveLength(0);
  // Recall is partial by design — the model covers what rules cannot — but it must not regress.
  expect(caught.length).toBeGreaterThanOrEqual(10);

  console.log(`deterministic layer: ${caught.length}/${positives.length} flagged, ` +
    `0/${negatives.length} false positives (${(caught.length / positives.length * 100).toFixed(0)}% recall, 100% precision)`);
});
