import { VerificationSchema,z } from '@humanize/domain';
import type { CandidateFinding,EvidenceRecord } from '@humanize/domain';
import type { CategoryName } from './router.js';

/**
 * The minimal shape the source-agnostic review logic needs from one reviewed unit of text. A
 * repository ContentNode satisfies this structurally today, and nothing here assumes a
 * repository, a commit, a blob or a file path exists — those stay in the caller (`reviewNodes`)
 * as repository-specific preparation, never here.
 */
export interface ReviewableUnit { id:string; text:string; placeholders:readonly string[]; }

export type SuppressionReason=
  |'text_not_in_node'|'foreign_node'|'category_not_routed'|'evidence_not_supplied'
  |'below_confidence'|'verifier_suppressed'|'verifier_missing_verdict'|'below_minimum_severity';

/**
 * Language that belongs to the review machinery rather than to the author. A verifier that
 * narrates its own checking, or names a candidate, is describing the process instead of the
 * writing.
 */
const META_COMMENTARY=/\b(?:the\s+(?:proposed\s+)?(?:finding|candidate)|candidate\s*id|corrected\s*explanation|reason\s*if\s*suppressed|evidence\s+(?:id|identifier)|the\s+reviewer|this\s+(?:review|verification)|suppress(?:ed|ion)?\b)/iu;
const WORDS=(value:string):string[]=>value.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[];
/** Long enough that ordinary prose will not collide, short enough to catch a quoted clause. */
const ECHO_LENGTH=8;

/**
 * Rejects a verifier "correction" that is not actually addressed to the author.
 *
 * A weaker model repeats its own instructions back: one live run published the sentence
 * "state the problem with their writing directly, in one or two sentences, addressed to them"
 * into a real pull request, because the correction was checked only for placeholders and
 * emptiness. Overlap is measured against the system prompt itself rather than a blacklist, so
 * the check keeps working when the prompt is reworded. Source-agnostic: it reads only the
 * correction text and the system prompt string the caller supplies.
 */
export function authorFacing(correction:string,system:string):boolean {
  if(META_COMMENTARY.test(correction))return false;
  const corrected=WORDS(correction);
  if(corrected.length<ECHO_LENGTH)return true;
  const instructions=WORDS(system);
  const echoes=new Set<string>();
  for(let index=0;index+ECHO_LENGTH<=instructions.length;index++)echoes.add(instructions.slice(index,index+ECHO_LENGTH).join(' '));
  for(let index=0;index+ECHO_LENGTH<=corrected.length;index++)if(echoes.has(corrected.slice(index,index+ECHO_LENGTH).join(' ')))return false;
  return true;
}

/** Placeholders a replacement must preserve, found in the reviewed text. */
const placeholdersOf=(value:string):string[]=>[...value.matchAll(/\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[^{}]+\}|%(?:\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]|%%/g)].map(match=>match[0]).sort();

/**
 * Deterministic gate between a model and a published finding. A candidate survives only if it
 * names the unit under review, quotes text that genuinely occurs in it, cites evidence that was
 * actually supplied, and stays inside the categories the router selected. Source-agnostic: it
 * reads only `unit.id`/`unit.text`, never repository identity — a caller attaches authoritative
 * coordinates afterward from whatever it knows about the unit's origin (INV-004, INV-014), which
 * is not this function's concern.
 */
export function validateCandidate(candidate:CandidateFinding,unit:ReviewableUnit,routed:readonly CategoryName[],evidence:ReadonlyMap<string,EvidenceRecord>):SuppressionReason|null {
  if(candidate.nodeId!==unit.id)return 'foreign_node';
  if(!unit.text.includes(candidate.exactText))return 'text_not_in_node';
  if(!routed.includes(candidate.category))return 'category_not_routed';
  for(const reference of candidate.evidence)if(!evidence.has(reference.id))return 'evidence_not_supplied';
  return null;
}

type VerificationResult=z.infer<typeof VerificationSchema>['results'][number];
export interface AppliedVerification { explanation:string; replacement:string|null; notAuthorFacing:boolean; placeholderDropped:boolean; }

/**
 * Resolves a verifier's optional correction against the reviewer's original candidate. A
 * correction is model output like any other: one that echoes the verifier's own instructions, or
 * drops a placeholder the original text carried, is discarded in favour of the reviewer's
 * original rather than trusted verbatim. Source-agnostic: reads only the candidate's own text
 * fields and the verdict, never a node or repository state — the caller passes its own verifier
 * system prompt so this function has no dependency on which surface is calling it.
 */
export function applyVerification(candidate:Pick<CandidateFinding,'exactText'|'explanation'|'replacement'>,verdict:VerificationResult,verifierSystem:string):AppliedVerification {
  const correctedExplanation=verdict.correctedExplanation?.trim();
  const usableCorrection=correctedExplanation&&authorFacing(correctedExplanation,verifierSystem);
  const explanation=usableCorrection?correctedExplanation:candidate.explanation;
  const corrected=verdict.correctedReplacement;
  const preservesPlaceholders=corrected===null||corrected===undefined
    ||JSON.stringify(placeholdersOf(candidate.exactText))===JSON.stringify(placeholdersOf(corrected));
  const replacement=corrected!==null&&corrected!==undefined&&preservesPlaceholders&&corrected.trim()
    ?corrected:candidate.replacement;
  return {
    explanation,replacement,
    notAuthorFacing:Boolean(correctedExplanation&&!usableCorrection),
    placeholderDropped:!preservesPlaceholders,
  };
}
