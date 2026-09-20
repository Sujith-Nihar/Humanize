import { extract } from '@humanize/extractors';
import type { ContentNode, SafeSuggestion } from '@humanize/domain';
import { applyReplacement, encodeReplacement } from './encode.js';
import type { EncodingFailure } from './encode.js';
import { validatePlaceholders } from './placeholders.js';
import type { PlaceholderViolation } from './placeholders.js';

export * from './encode.js';
export * from './placeholders.js';

export type SuggestionRejection =
  | EncodingFailure
  | PlaceholderViolation
  | 'EMPTY_REPLACEMENT'
  | 'UNCHANGED'
  | 'REPARSE_FAILED'
  | 'STRUCTURE_CHANGED'
  | 'TEXT_NOT_APPLIED'
  | 'RANGE_NOT_IN_DIFF';

export interface SuggestionRequest {
  node: ContentNode;
  replacement: string;
  source: string;
  headSha: string;
  /** Right-hand-side lines the pull request actually changed. */
  changedLines?: readonly number[];
}
export type SuggestionOutcome =
  | { published: true; suggestion: SafeSuggestion }
  | { published: false; reasons: SuggestionRejection[] };

/**
 * A node's identity excluding position, so the same string moving by a few characters after a
 * replacement is still recognised as the same node rather than looking like a new one.
 */
const shape = (node: ContentNode): string => `${node.filePath}|${node.stableKey}|${node.sourceKind}|${node.kind}`;

/**
 * Builds a one-click suggestion, or explains why it cannot. Every check must pass: the node
 * must be safe to replace, placeholders must survive, the encoded patch must re-parse, and the
 * re-parsed file must differ from the original in exactly one way — the text of this node.
 *
 * A replacement can be syntactically valid and still be wrong: prose that opens a JSX
 * expression or an HTML attribute parses cleanly while changing what the file *does*. The
 * structural comparison is what catches that, so it is not optional.
 */
export function buildSuggestion(request: SuggestionRequest): SuggestionOutcome {
  const { node, replacement, source } = request;
  const reasons: SuggestionRejection[] = [];

  if (!replacement.trim()) reasons.push('EMPTY_REPLACEMENT');
  if (replacement === node.text) reasons.push('UNCHANGED');
  reasons.push(...validatePlaceholders(node.text, replacement));

  // A suggestion GitHub cannot attach to the diff is not a suggestion the author can apply.
  if (request.changedLines !== undefined) {
    const inDiff = request.changedLines.some(line => line >= node.startLine && line <= node.endLine);
    if (!inDiff) reasons.push('RANGE_NOT_IN_DIFF');
  }

  const encoded = encodeReplacement(node, replacement);
  if (!encoded.ok) reasons.push(encoded.failure);
  if (reasons.length || !encoded.ok) return { published: false, reasons: [...new Set(reasons)].sort() };

  const patched = applyReplacement(source, node, encoded.value.encoded);
  const before = extract({ repositoryId: node.repositoryId, commitSha: node.commitSha, blobSha: node.blobSha, filePath: node.filePath, source });
  const after = extract({ repositoryId: node.repositoryId, commitSha: node.commitSha, blobSha: node.blobSha, filePath: node.filePath, source: patched });

  if (after.diagnostics.some(diagnostic => diagnostic.code === 'PARSE_FAILURE') || (before.nodes.length > 0 && after.nodes.length === 0)) {
    return { published: false, reasons: ['REPARSE_FAILED'] };
  }
  // Exactly one node may differ, and only in its text: anything else means the patch changed
  // the structure of the file rather than the words in it.
  if (before.nodes.length !== after.nodes.length) return { published: false, reasons: ['STRUCTURE_CHANGED'] };

  const changed: ContentNode[] = [];
  for (let index = 0; index < before.nodes.length; index++) {
    const original = before.nodes[index]!, updated = after.nodes[index]!;
    if (shape(original) !== shape(updated)) return { published: false, reasons: ['STRUCTURE_CHANGED'] };
    if (original.text !== updated.text) changed.push(updated);
  }
  if (changed.length !== 1) return { published: false, reasons: ['STRUCTURE_CHANGED'] };
  if (changed[0]!.text !== replacement) return { published: false, reasons: ['TEXT_NOT_APPLIED'] };

  return {
    published: true,
    suggestion: {
      path: node.filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      // GitHub replaces whole lines, so the suggestion carries the patched lines verbatim.
      replacement: patched.split('\n').slice(node.startLine - 1, node.endLine).join('\n'),
      sourceHash: node.blobSha,
      headSha: request.headSha,
    },
  };
}
