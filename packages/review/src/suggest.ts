import { buildSuggestion } from '@humanize/suggestions';
import type { DiffMap, ValidatedFinding } from '@humanize/domain';

/** Reads a file at the reviewed commit. The control plane fetches it itself (ADR-026). */
export type SourceReader = (filePath: string) => Promise<string | null>;

export interface SuggestionOutcome { attached: number; refused: Record<string, number> }

/**
 * Attaches one-click suggestions to findings that propose a replacement.
 *
 * The runner is not asked for the patch and could not be trusted with it: a compromised one
 * would otherwise put arbitrary text behind a button the author clicks against their own
 * repository. The control plane fetches the file at the reviewed commit and proves the patch
 * itself — the replacement must preserve every placeholder, the patched file must re-parse, and
 * it must differ from the original in exactly one way, the text of this node (INV-005, ADR-030).
 *
 * Anything that fails stays a comment, which is always publishable.
 */
export async function attachSuggestions(
  findings: readonly ValidatedFinding[], diff: DiffMap, headSha: string, read: SourceReader,
): Promise<SuggestionOutcome> {
  const sources = new Map<string, string | null>();
  const refused: Record<string, number> = {};
  let attached = 0;

  for (const finding of findings) {
    if (finding.replacement === null || finding.replacement === undefined) continue;
    const path = finding.node.filePath;
    if (!sources.has(path)) sources.set(path, await read(path));
    const source = sources.get(path) ?? null;
    if (source === null) { refused.SOURCE_UNAVAILABLE = (refused.SOURCE_UNAVAILABLE ?? 0) + 1; continue; }

    const changedLines = diff.files.find(file => file.newPath === path)?.addedLines ?? [];
    const built = buildSuggestion({ node: finding.node, replacement: finding.replacement, source, headSha, changedLines });
    if (built.published) { finding.suggestion = built.suggestion; attached++; continue; }
    for (const reason of built.reasons) refused[reason] = (refused[reason] ?? 0) + 1;
  }
  return { attached, refused };
}
