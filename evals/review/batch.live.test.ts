import { expect, it } from 'vitest';
import { Category } from '@humanize/domain';
import type { ContentNode, ReviewSnapshot } from '@humanize/domain';
import { OllamaProvider } from '@humanize/providers';
import { EphemeralContextIndex, buildContext } from '@humanize/retrieval';
import { evaluateRules } from '@humanize/rules';
import { reviewNodes, routeNode } from '@humanize/review';
import type { CategoryName, NodeSignal, ReviewOutcome } from '@humanize/review';
import { REVIEW_GOLD } from './gold.js';

/**
 * Stage 1 acceptance (plan-production-review.md): a 12-node review completes in under two
 * minutes. Set HUMANIZE_BATCH_BASELINE=1 to also review the same nodes one call at a time,
 * which is exactly the behaviour before batching, for a like-for-like comparison.
 */
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

const node = (id: string, kind: ContentNode['kind'], text: string, line: number): ContentNode => ({
  id, repositoryId: 'repo', commitSha: headSha, filePath: 'app/page.tsx', blobSha: 'd'.repeat(40), parser: 'babel', parserVersion: '1',
  startLine: line, endLine: line, startOffset: 0, endOffset: text.length, text, normalizedText: text.toLowerCase(), kind, sourceKind: 'jsx_text',
  dynamic: false, visibilityConfidence: 1, placeholders: [], stableKey: `stable-${id}`, mappingVersion: 1, segments: [], extractionConfigHash: 'config', suggestionSafe: true,
});

// Twelve changed nodes in one file, as a pull request would present them.
const nodes = REVIEW_GOLD.map((testCase, index) => node(testCase.id, testCase.kind, testCase.text, index + 1))
  .filter(candidate => routeNode(candidate, { enabled }).eligible).slice(0, 12);
const index = new EphemeralContextIndex(snapshot, nodes);
const provider = new OllamaProvider(baseUrl, true);
const ports = {
  reviewer: provider, reviewerModel: model, verifier: provider, verifierModel: model,
  context: async (candidate: ContentNode) => (await buildContext({ node: candidate, index })).evidence,
  rules: (candidate: ContentNode) => evaluateRules(candidate, {}) as NodeSignal[],
};

function summarise(label: string, outcomes: ReviewOutcome[], ms: number) {
  const reasons = new Map<string, number>();
  for (const outcome of outcomes) for (const entry of outcome.suppressed) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  const diagnostics = new Map<string, number>();
  for (const outcome of outcomes) for (const entry of outcome.diagnostics) diagnostics.set(entry.code, (diagnostics.get(entry.code) ?? 0) + entry.count);
  const summary = {
    label, seconds: Math.round(ms / 100) / 10,
    findings: outcomes.reduce((sum, outcome) => sum + outcome.findings.length, 0),
    modelFindings: outcomes.reduce((sum, outcome) => sum + outcome.findings.filter(finding => !finding.deterministic).length, 0),
    failures: outcomes.flatMap(outcome => outcome.failures),
    suppressed: Object.fromEntries(reasons), diagnostics: Object.fromEntries(diagnostics),
  };
  console.log(`\n=== ${label} (${model}, ${nodes.length} nodes) ===\n${JSON.stringify(summary, null, 2)}`);
  return summary;
}

it('reviews twelve changed nodes in under two minutes', async () => {
  expect(nodes).toHaveLength(12);
  if (process.env.HUMANIZE_BATCH_BASELINE === '1') {
    const started = performance.now();
    const outcomes: ReviewOutcome[] = [];
    for (const single of nodes) outcomes.push(await reviewNodes(snapshot, [single], ports, { enabled, timeoutMs: 180000 }));
    summarise('one call per node (before)', outcomes, performance.now() - started);
  }
  const started = performance.now();
  const outcome = await reviewNodes(snapshot, nodes, ports, { enabled, timeoutMs: 180000 });
  const summary = summarise('batched (after)', [outcome], performance.now() - started);
  expect(outcome.reviewed).toBe(12);
  expect(summary.seconds).toBeLessThan(120);
}, 1_800_000);
