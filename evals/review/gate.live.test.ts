import { expect, it } from 'vitest';
import { Category } from '@humanize/domain';
import type { ContentNode, ReviewSnapshot } from '@humanize/domain';
import { OllamaProvider } from '@humanize/providers';
import { EphemeralContextIndex, buildContext } from '@humanize/retrieval';
import { evaluateRules } from '@humanize/rules';
import { planPublication, reviewNodes } from '@humanize/review';
import type { CategoryName, NodeSignal } from '@humanize/review';
import { REVIEW_GOLD } from './gold.js';

const baseUrl = process.env.HUMANIZE_OLLAMA_BASE_URL;
const model = process.env.HUMANIZE_OLLAMA_MODEL;
if (!baseUrl || !model) throw Error('Set HUMANIZE_OLLAMA_BASE_URL and HUMANIZE_OLLAMA_MODEL; a live test is never silently skipped.');

const headSha = 'b'.repeat(40);
const profile = { provider: 'ollama' as const, model, credentialRef: null, maxInputTokens: 12000, maxOutputTokens: 4000, evaluatedLanguages: ['en'] };
const snapshot: ReviewSnapshot = {
  version: 1, organizationId: 'org', repositoryId: 'repo', installationId: 7, owner: 'acme', repository: 'site', pullNumber: 1,
  baseSha: 'a'.repeat(40), headSha, configSha: 'c'.repeat(40), configHash: 'config', executionMode: 'runner', retentionMode: 'ephemeral',
  reviewer: profile, verifier: profile, language: 'en', allowUnevaluatedLanguage: false,
};
const enabled = Object.fromEntries(Category.options.map(category => [category, true])) as Record<CategoryName, boolean>;

const node = (id: string, kind: ContentNode['kind'], text: string): ContentNode => ({
  id, repositoryId: 'repo', commitSha: headSha, filePath: `app/${id}.tsx`, blobSha: 'd'.repeat(40), parser: 'babel', parserVersion: '1',
  startLine: 1, endLine: 1, startOffset: 0, endOffset: text.length, text, normalizedText: text.toLowerCase(), kind, sourceKind: 'jsx_text',
  dynamic: false, visibilityConfidence: 1, placeholders: [], stableKey: `stable-${id}`, mappingVersion: 1, segments: [], extractionConfigHash: 'config', suggestionSafe: true,
});

it('measures review precision against the labelled corpus', async () => {
  const provider = new OllamaProvider(baseUrl, true);
  const outcomes: { id: string; expected: boolean; actual: boolean; legitimate: boolean; ambiguous: boolean; categories: string[]; note: string }[] = [];

  for (const testCase of REVIEW_GOLD) {
    const target = node(testCase.id, testCase.kind, testCase.text);
    const index = new EphemeralContextIndex(snapshot, [target]);
    const result = await reviewNodes(snapshot, [target], {
      reviewer: provider, reviewerModel: model, verifier: provider, verifierModel: model,
      context: async candidate => (await buildContext({ node: candidate, index })).evidence,
      rules: candidate => evaluateRules(candidate, { blockingRules: [{ type: 'forbidden_phrase', phrase: '100% secure' }] }) as NodeSignal[],
    }, { enabled, timeoutMs: 180000 });
    // Only what would actually reach the pull request counts, so ranking and the budget apply.
    const published = planPublication(result.findings).inline;
    outcomes.push({
      id: testCase.id, expected: testCase.comment, actual: published.length > 0,
      legitimate: testCase.legitimate === true, ambiguous: testCase.ambiguous === true,
      categories: published.map(finding => finding.category), note: testCase.note,
    });
  }

  const truePositive = outcomes.filter(o => o.expected && o.actual);
  const falsePositive = outcomes.filter(o => !o.expected && o.actual);
  const falseNegative = outcomes.filter(o => o.expected && !o.actual);
  const precision = truePositive.length + falsePositive.length === 0 ? 1 : truePositive.length / (truePositive.length + falsePositive.length);
  const recall = truePositive.length + falseNegative.length === 0 ? 1 : truePositive.length / (truePositive.length + falseNegative.length);
  const legitimateFlagged = falsePositive.filter(o => o.legitimate);

  const clear = outcomes.filter(o => !o.ambiguous);
  const clearTp = clear.filter(o => o.expected && o.actual).length;
  const clearFp = clear.filter(o => !o.expected && o.actual).length;
  const clearFn = clear.filter(o => o.expected && !o.actual).length;
  const clearPrecision = clearTp + clearFp === 0 ? 1 : clearTp / (clearTp + clearFp);
  const clearRecall = clearTp + clearFn === 0 ? 1 : clearTp / (clearTp + clearFn);

  console.log(`\n=== REVIEW GOLD SET (${model}) ===`);
  console.log(`all ${outcomes.length} cases        precision ${(precision * 100).toFixed(1)}%   recall ${(recall * 100).toFixed(1)}%`);
  console.log(`clear-cut ${clear.length} cases   precision ${(clearPrecision * 100).toFixed(1)}%   recall ${(clearRecall * 100).toFixed(1)}%`);
  console.log(`\nfalse positives (commented on sound writing) — ${falsePositive.length}:`);
  for (const o of falsePositive) console.log(`  ${o.id}${o.legitimate ? ' [legitimate promotional]' : ''}: ${o.categories.join(', ')}\n     ${o.note}`);
  console.log(`\nfalse negatives (missed weak writing) — ${falseNegative.length}:`);
  for (const o of falseNegative) console.log(`  ${o.id}: ${o.note}`);

  // Regression floors, set below the measured baseline of precision 100% and recall 100% on
  // qwen3.5:4b after ADR-037. These are not the specification's release thresholds, which
  // require independent human judgement of usefulness on a far larger corpus.
  expect(outcomes).toHaveLength(REVIEW_GOLD.length);
  // Clear-cut cases carry the floor, because an ambiguous failure may mean the label is wrong.
  expect.soft(clearPrecision, `clear-cut precision; false positives ${JSON.stringify(clear.filter(o => !o.expected && o.actual).map(o => o.id))}`).toBeGreaterThanOrEqual(0.8);
  expect.soft(clearRecall, `clear-cut recall; missed ${JSON.stringify(clear.filter(o => o.expected && !o.actual).map(o => o.id))}`).toBeGreaterThanOrEqual(0.8);
  expect.soft(legitimateFlagged.length, `legitimate promotional copy flagged: ${JSON.stringify(legitimateFlagged.map(o => o.id))}`).toBe(0);
  console.log(`\nbaseline: precision 100.0%, recall 100.0% (qwen3.5:4b, 16 cases, after ADR-037)`);
}, 900000);
