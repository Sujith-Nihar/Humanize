import { buildSuggestion } from '@humanize/suggestions';
import type { DiffMap, ValidatedFinding } from '@humanize/domain';

/**
 * Concrete facts a rewrite must carry over: numbers and percentages, acronyms, brand tokens
 * with internal capitals, and URLs. Ordinary capitalisation is deliberately not a signal,
 * because headings are often title case and every word would look like a proper noun.
 */
const FACTS=/\d[\d.,]*%?|\b[A-Z]{2,}\b|\b[A-Za-z]+[A-Z][A-Za-z]*\b|https?:\/\/\S+/gu;

/**
 * Facts present in the original that the replacement drops.
 *
 * A suggestion changes how something is written, never what it says. This is a backstop and
 * not a semantic guarantee — it cannot tell that dropping a clause lost a claim — so it is
 * paired with rules that decline to propose a deletion at all unless what they remove is a
 * negation of the sentence beside it.
 */
export function informationLost(original:string,replacement:string):string[] {
  const present=new Set(replacement.match(FACTS)??[]);
  return [...new Set(original.match(FACTS)??[])].filter(fact=>!present.has(fact));
}

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

    // An edit that drops a number, an acronym or a brand name is not a rewrite, it is a
    // deletion wearing a rewrite's clothes. Refused before the patch is even built.
    const lost = informationLost(finding.node.text, finding.replacement);
    if (lost.length > 0) { refused.INFORMATION_LOST = (refused.INFORMATION_LOST ?? 0) + 1; continue; }

    const changedLines = diff.files.find(file => file.newPath === path)?.addedLines ?? [];
    const built = buildSuggestion({ node: finding.node, replacement: finding.replacement, source, headSha, changedLines });
    if (built.published) { finding.suggestion = built.suggestion; attached++; continue; }
    for (const reason of built.reasons) refused[reason] = (refused[reason] ?? 0) + 1;
  }
  return { attached, refused };
}
