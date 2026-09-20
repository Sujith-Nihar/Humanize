import { expect, it } from 'vitest';
import { DIGEST_VERSION, ReviewSnapshotSchema, domainDigest, runnerResultDigest, snapshotDigest } from './src/index.js';
import type { ReviewSnapshot } from './src/index.js';

const profile = { provider: 'ollama' as const, model: 'fixture', credentialRef: null, maxInputTokens: 12000, maxOutputTokens: 4000, evaluatedLanguages: ['en'] };
const snapshot: ReviewSnapshot = {
  version: 1, organizationId: 'org', repositoryId: 'repo', installationId: 7, owner: 'acme', repository: 'site',
  pullNumber: 3, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), configSha: 'c'.repeat(40), configHash: 'config',
  executionMode: 'runner', retentionMode: 'ephemeral', reviewer: profile, verifier: profile, language: 'en', allowUnevaluatedLanguage: false,
};
const result = {
  version: 1 as const, leaseId: '11111111-1111-4111-8111-111111111111', fence: 1,
  runId: '22222222-2222-4222-8222-222222222222', snapshotHash: snapshotDigest(snapshot),
  nodes: [], candidates: [], evidence: [], verification: { results: [] }, diagnostics: [{ code: 'PARSER_FAILED', count: 1 }],
};

// PostgreSQL JSONB re-orders object keys; reversing every key order simulates that.
const reorder = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(reorder) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) as T;
  return value;
};

it('is stable across key reordering, wire transport and repeated parsing', () => {
  const expected = snapshotDigest(snapshot);
  expect(snapshotDigest(JSON.parse(JSON.stringify(snapshot)))).toBe(expected);
  expect(snapshotDigest(reorder(snapshot))).toBe(expected);
  expect(snapshotDigest(ReviewSnapshotSchema.parse(snapshot))).toBe(expected);
  expect(runnerResultDigest(reorder(result))).toBe(runnerResultDigest(result));
  expect(runnerResultDigest(JSON.parse(JSON.stringify(result)))).toBe(runnerResultDigest(result));
});

it('applies schema defaults so equivalent snapshots agree', () => {
  const { language: _language, allowUnevaluatedLanguage: _flag, ...withoutDefaults } = snapshot;
  expect(snapshotDigest(withoutDefaults)).toBe(snapshotDigest(snapshot));
});

it('separates payload kinds and digest versions', () => {
  expect(domainDigest('review-snapshot', ReviewSnapshotSchema.parse(snapshot))).toBe(snapshotDigest(snapshot));
  expect(domainDigest('runner-result', ReviewSnapshotSchema.parse(snapshot))).not.toBe(snapshotDigest(snapshot));
  expect(DIGEST_VERSION).toBe('humanize-digest-1');
});

it('changes when any reviewed value changes', () => {
  expect(snapshotDigest({ ...snapshot, headSha: 'd'.repeat(40) })).not.toBe(snapshotDigest(snapshot));
  expect(snapshotDigest({ ...snapshot, reviewer: { ...profile, model: 'other' } })).not.toBe(snapshotDigest(snapshot));
  expect(runnerResultDigest({ ...result, diagnostics: [{ code: 'PARSER_FAILED', count: 2 }] })).not.toBe(runnerResultDigest(result));
});

it('refuses to digest payloads that fail their schema', () => {
  expect(() => snapshotDigest({ ...snapshot, headSha: 'not-a-sha' })).toThrow();
  expect(() => snapshotDigest({ ...snapshot, unexpected: true })).toThrow();
  expect(() => runnerResultDigest({ ...result, fence: 0 })).toThrow();
});
