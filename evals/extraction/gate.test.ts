import { expect, it } from 'vitest';
import { extract } from '@humanize/extractors';
import { GOLD } from './gold.js';

/** Release gates from the specification. Extraction quality is measured, never assumed. */
const THRESHOLDS = { precision: 0.98, recall: 0.9, rangeAccuracy: 0.99 };

interface Measurement { parser: string; precision: number; recall: number; rangeAccuracy: number; missed: string[]; spurious: string[] }

function measure(): Measurement[] {
  const byParser = new Map<string, { expected: number; found: number; correct: number; ranges: number; exact: number; missed: string[]; spurious: string[] }>();
  for (const testCase of GOLD) {
    const stats = byParser.get(testCase.parser) ?? { expected: 0, found: 0, correct: 0, ranges: 0, exact: 0, missed: [], spurious: [] };
    const result = extract({ repositoryId: 'repo', commitSha: 'b'.repeat(40), blobSha: 'd'.repeat(40), filePath: testCase.filePath, source: testCase.source });
    const extracted = result.nodes.map(node => node.text);

    for (const expected of testCase.visible) {
      stats.expected++;
      if (extracted.includes(expected)) stats.correct++;
      else stats.missed.push(expected);
    }
    for (const text of extracted) {
      stats.found++;
      // Anything extracted that the label does not call visible is a false positive.
      if (!testCase.visible.includes(text)) stats.spurious.push(text);
    }
    for (const node of result.nodes) {
      stats.ranges++;
      // A node's text may be assembled from several source runs, as a Markdown paragraph
      // containing an inline link is, so accuracy is measured per segment: every segment must
      // map its slice of the text back to the exact source it came from.
      const accurate = node.segments.length > 0 && node.segments.every(segment => {
        const slice = testCase.source.slice(segment.sourceStart, segment.sourceEnd);
        const claimed = node.text.slice(segment.textStart, segment.textEnd);
        // Identity encoding promises the source and the text are the same bytes. Any other
        // encoding means they legitimately differ, and the promise is only that the span is
        // real and the node is not offered as a verbatim replacement.
        return segment.encoding === 'identity' ? slice === claimed : slice.length > 0 && !node.suggestionSafe;
      });
      if (accurate) stats.exact++;
    }
    byParser.set(testCase.parser, stats);
  }

  return [...byParser.entries()].map(([parser, stats]) => ({
    parser,
    precision: stats.found === 0 ? 1 : (stats.found - stats.spurious.length) / stats.found,
    recall: stats.expected === 0 ? 1 : stats.correct / stats.expected,
    rangeAccuracy: stats.ranges === 0 ? 1 : stats.exact / stats.ranges,
    missed: stats.missed,
    spurious: stats.spurious,
  }));
}

it('meets the per-parser extraction release thresholds', () => {
  const measurements = measure();
  const report = measurements.map(m =>
    `${m.parser.padEnd(12)} precision ${(m.precision * 100).toFixed(1)}%  recall ${(m.recall * 100).toFixed(1)}%  ranges ${(m.rangeAccuracy * 100).toFixed(1)}%` +
    `${m.missed.length ? `\n    missed: ${JSON.stringify(m.missed)}` : ''}` +
    `${m.spurious.length ? `\n    spurious: ${JSON.stringify(m.spurious)}` : ''}`).join('\n');
  console.log(`\n=== EXTRACTION GATE ===\n${report}\n`);

  expect(measurements.length).toBeGreaterThanOrEqual(7);
  for (const measurement of measurements) {
    expect.soft(measurement.precision, `${measurement.parser} precision; spurious ${JSON.stringify(measurement.spurious)}`).toBeGreaterThanOrEqual(THRESHOLDS.precision);
    expect.soft(measurement.recall, `${measurement.parser} recall; missed ${JSON.stringify(measurement.missed)}`).toBeGreaterThanOrEqual(THRESHOLDS.recall);
    expect.soft(measurement.rangeAccuracy, `${measurement.parser} range accuracy`).toBeGreaterThanOrEqual(THRESHOLDS.rangeAccuracy);
  }
});

it('never extracts a string the corpus labels as machine content', () => {
  for (const testCase of GOLD) {
    const extracted = extract({ repositoryId: 'repo', commitSha: 'b'.repeat(40), blobSha: 'd'.repeat(40), filePath: testCase.filePath, source: testCase.source })
      .nodes.map(node => node.text);
    for (const ignored of testCase.ignored) {
      // A URL or an identifier reviewed as prose is worse than a missed string: it is noise
      // in a pull request about something the author never wrote for a reader.
      expect(extracted, `${testCase.parser} extracted machine content ${JSON.stringify(ignored)}`).not.toContain(ignored);
    }
  }
});

it('extracts the placeholders each labelled string must carry', () => {
  for (const testCase of GOLD) {
    const nodes = extract({ repositoryId: 'repo', commitSha: 'b'.repeat(40), blobSha: 'd'.repeat(40), filePath: testCase.filePath, source: testCase.source }).nodes;
    for (const [text, expected] of Object.entries(testCase.placeholders ?? {})) {
      const node = nodes.find(candidate => candidate.text === text);
      // A placeholder the extractor misses is one a suggestion could silently drop.
      expect(node?.placeholders, `${testCase.filePath} placeholders for ${JSON.stringify(text)}`).toEqual(expected);
    }
  }
});

it('never offers a labelled-unsafe string as a one-click replacement', () => {
  for (const testCase of GOLD) {
    const nodes = extract({ repositoryId: 'repo', commitSha: 'b'.repeat(40), blobSha: 'd'.repeat(40), filePath: testCase.filePath, source: testCase.source }).nodes;
    for (const text of testCase.unsafe ?? []) {
      const node = nodes.find(candidate => candidate.text === text);
      expect(node, `${testCase.filePath} did not extract ${JSON.stringify(text)}`).toBeDefined();
      // Source and rendered text differ here, so a verbatim patch would corrupt the file.
      expect(node?.suggestionSafe, `${testCase.filePath} offered an unsafe replacement for ${JSON.stringify(text)}`).toBe(false);
    }
  }
});
