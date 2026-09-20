import { LIMITS } from '@humanize/domain';
import type { ValidatedFinding } from '@humanize/domain';

export interface RankedFinding extends ValidatedFinding { score:number; }
export interface PublicationPlan {
  /** Posted as inline comments on the pull request. */
  inline:RankedFinding[];
  /** Reported in the summary only, so the diff stays readable. */
  summary:RankedFinding[];
  dropped:number;
}
export interface RankingOptions {
  maxSubjectiveInline?:number;
  includeNits?:boolean;
}

const SEVERITY_WEIGHT={major:1,minor:0.6,nit:0.25} as const;

/**
 * Deterministic score. The coefficients are a starting point, not a calibrated model: the
 * specification requires them to be evaluation-driven, so they are expected to change once
 * a labelled corpus exists. Nothing here depends on iteration order.
 */
export function scoreFinding(finding:ValidatedFinding):number {
  const evidenceQuality=Math.min(1,finding.evidenceRecords.length/2);
  const actionability=finding.replacement===null?0.8:1;
  const confidence=Math.min(finding.confidence,finding.verificationConfidence);
  return Number((confidence*SEVERITY_WEIGHT[finding.severity]*(0.5+evidenceQuality/2)*finding.node.visibilityConfidence*actionability).toFixed(6));
}

const overlaps=(a:ValidatedFinding,b:ValidatedFinding):boolean=>{
  if(a.node.filePath!==b.node.filePath)return false;
  const aStart=a.node.text.indexOf(a.exactText),bStart=b.node.text.indexOf(b.exactText);
  if(a.node.id===b.node.id&&aStart>=0&&bStart>=0){
    // One quotation containing the other is the same observation stated twice.
    return aStart<bStart+b.exactText.length&&bStart<aStart+a.exactText.length;
  }
  return a.node.startLine<=b.node.endLine&&b.node.startLine<=a.node.endLine;
};

/** Two findings are the same finding when they say the same thing about the same place. */
function duplicate(a:RankedFinding,b:RankedFinding):boolean {
  if(a.fingerprint===b.fingerprint)return true;
  // One node is one place in the diff. Several findings of the same category on it would
  // stack comments on a single line, which reads as noise however distinct their quotations.
  if(a.category===b.category&&a.node.id===b.node.id)return true;
  if(a.category===b.category&&overlaps(a,b))return true;
  return a.replacement!==null&&a.replacement===b.replacement&&overlaps(a,b);
}

/**
 * Ranks, merges and budgets findings. A reviewer that posts a dozen overlapping comments gets
 * uninstalled, so the budget is a hard default rather than a suggestion: only the strongest
 * subjective findings become inline comments and the rest move to the summary. Deterministic
 * policy violations are exempt, because the customer asked for those explicitly.
 */
export function planPublication(findings:readonly ValidatedFinding[],options:RankingOptions={}):PublicationPlan {
  const limit=Math.min(options.maxSubjectiveInline??LIMITS.subjectiveInline,LIMITS.subjectiveInline);
  const ranked=findings
    .filter(finding=>options.includeNits===true||finding.severity!=='nit'||finding.deterministic)
    .map(finding=>({...finding,score:scoreFinding(finding)}))
    .sort((left,right)=>right.score-left.score||left.fingerprint.localeCompare(right.fingerprint,'en'));

  const kept:RankedFinding[]=[];
  let dropped=findings.length-ranked.length;
  for(const finding of ranked){
    // The stronger finding is already in `kept`, so a weaker restatement is discarded.
    if(kept.some(existing=>duplicate(existing,finding))){dropped++;continue;}
    kept.push(finding);
  }

  const inline:RankedFinding[]=[],summary:RankedFinding[]=[];
  let subjective=0;
  for(const finding of kept){
    if(finding.deterministic||finding.blocking){inline.push(finding);continue;}
    if(subjective<limit){inline.push(finding);subjective++;continue;}
    summary.push(finding);
  }
  return {inline,summary,dropped};
}
