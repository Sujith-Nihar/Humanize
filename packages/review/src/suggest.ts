import { buildSuggestion } from '@humanize/suggestions';
import type { DiffMap, ValidatedFinding } from '@humanize/domain';

/**
 * Concrete facts a rewrite must carry over: numbers and percentages, acronyms, brand tokens
 * with internal capitals, and URLs. Ordinary capitalisation is deliberately not a signal,
 * because headings are often title case and every word would look like a proper noun.
 */
const FACTS=/\d[\d.,]*%?|\b[A-Z]{2,}\b|\b[A-Za-z]+[A-Z][A-Za-z]*\b|https?:\/\/\S+/gu;

/** Words carrying meaning. Dropping these is how a "rewrite" quietly becomes a deletion. */
const FILLER=new Set(['a','an','and','are','as','at','be','been','but','by','for','from','has','have','in','into','is','it','its','of','on','or','that','the','to','was','were','will','with','you','your','we','our','this','these','there','their','they','he','she','i','not','no','just','so','if','then','than','can','could','would','should','may','might','do','does','did','done','get','got']);
const contentWords=(value:string):string[]=>
  (value.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[]).filter(word=>!FILLER.has(word));

/**
 * A replacement this much shorter than the original is a deletion wearing a rewrite's clothes.
 *
 * Derived from the case that prompted this check rather than guessed: dropping "— Designed for
 * the Mind" from a heading leaves 3 of 5 content words, or 0.6, and that edit loses a claim
 * about what the product is for. The floor therefore sits above it. The sanctioned negation
 * removal keeps 0.86 and a genuine rewrite of similar length keeps 0.8, so both still pass.
 */
const MIN_LENGTH_RATIO=0.7;
export type InformationLoss='FACT_DROPPED'|'TEXT_TRUNCATED';

/**
 * Ways a replacement fails to say what the original said.
 *
 * A suggestion changes how something is written, never what it says. Measured on live output,
 * a facts-only check was not close to sufficient: a model proposed replacing the button text
 * "Get Started — Listen Now" with the single character "—", and truncating a sentence to its
 * trailing clause. Neither contains a number or a brand name, so both passed. Length and
 * content-word retention catch what a fact list cannot.
 *
 * This remains a backstop rather than a semantic guarantee — it cannot tell that a reworded
 * claim now means something different — which is why rules decline to rewrite prose at all and
 * anything refused stays a comment.
 */
export function informationLoss(original:string,replacement:string):InformationLoss[] {
  const reasons:InformationLoss[]=[];
  const present=new Set(replacement.match(FACTS)??[]);
  if([...new Set(original.match(FACTS)??[])].some(fact=>!present.has(fact)))reasons.push('FACT_DROPPED');

  // Length, not word retention. Retention was tried and rejected: it fails a genuine rewrite,
  // because recasting "cuts review time" as "reviews faster" drops three content words while
  // saying the same thing. Rephrasing is the point; shrinking is the problem.
  const before=contentWords(original),after=contentWords(replacement);
  if(before.length>0&&after.length/before.length<MIN_LENGTH_RATIO)reasons.push('TEXT_TRUNCATED');
  return reasons;
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

    // Refused before the patch is even built, and refused by name: an operator needs to know
    // whether a model truncated a sentence or recast it beyond recognition.
    const lost = informationLoss(finding.node.text, finding.replacement);
    if (lost.length > 0) { for (const reason of lost) refused[reason] = (refused[reason] ?? 0) + 1; continue; }

    const changedLines = diff.files.find(file => file.newPath === path)?.addedLines ?? [];
    const built = buildSuggestion({ node: finding.node, replacement: finding.replacement, source, headSha, changedLines });
    if (built.published) { finding.suggestion = built.suggestion; attached++; continue; }
    for (const reason of built.reasons) refused[reason] = (refused[reason] ?? 0) + 1;
  }
  return { attached, refused };
}
