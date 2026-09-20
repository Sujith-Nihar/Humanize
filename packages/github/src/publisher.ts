import type { DiffMap,FileDiff,ValidatedFinding } from '@humanize/domain';
import { representableRange } from './index.js';

export interface PublishableFinding extends ValidatedFinding { score?:number; }
export interface ReviewComment { path:string; line:number; side:'RIGHT'; body:string; }
export interface ReviewPayload {
  event:'COMMENT';
  body:string;
  comments:ReviewComment[];
}
export type CheckConclusion='success'|'neutral'|'failure';
export interface CheckPayload { conclusion:CheckConclusion; title:string; summary:string; }

/** Identifies Humanize's own review so a re-review updates it instead of adding another. */
export const REVIEW_MARKER='<!-- humanize:review -->';
export const commentMarker=(fingerprint:string):string=>`<!-- humanize:finding:${fingerprint} -->`;

const CATEGORY_LABEL:Record<string,string>={
  ai_like_generic:'Generic / AI-like wording',clarity:'Clarity',repository_style:'Repository style',
  approved_voice:'Approved voice',terminology:'Terminology',repetition:'Repetition',
  claim_inconsistency:'Possible claim inconsistency',unsupported_claim:'Possible unsupported claim',
};

/**
 * Renders one finding. The wording states what is observable about the writing and never
 * asserts who or what authored it, which is the product's central promise (INV-006).
 */
export function renderComment(finding:PublishableFinding):string {
  const lines=[commentMarker(finding.fingerprint),`**${CATEGORY_LABEL[finding.category]??finding.category}** (${finding.severity})`,'',finding.explanation];
  const evidence=finding.evidenceRecords.filter(record=>record.filePath!==undefined&&record.filePath!==finding.node.filePath);
  if(evidence.length)lines.push('',`Related repository content: ${[...new Set(evidence.map(record=>`\`${record.filePath}\``))].slice(0,3).join(', ')}`);
  if(finding.suggestion){
    // A native suggestion block is the only fix mechanism; it needs no write permission.
    lines.push('','```suggestion',finding.suggestion.replacement,'```');
  }
  return lines.join('\n');
}

/** A comment may only be attached to a right-hand-side line the pull request actually changed. */
export function commentableLine(finding:PublishableFinding,diff:DiffMap):number|null {
  const file:FileDiff|undefined=diff.files.find(entry=>entry.newPath===finding.node.filePath);
  if(!file)return null;
  for(let line=finding.node.startLine;line<=finding.node.endLine;line++){
    if(file.addedLines.includes(line)&&representableRange(file,line,line))return line;
  }
  return null;
}

export function renderSummary(input:{inline:PublishableFinding[];summary:PublishableFinding[];unplaced:PublishableFinding[];reviewedNodes:number}):string {
  const lines=[REVIEW_MARKER,'## Humanize content review',''];
  const total=input.inline.length+input.summary.length+input.unplaced.length;
  lines.push(total
    ? `Reviewed ${input.reviewedNodes} changed piece${input.reviewedNodes===1?'':'s'} of user-visible content and raised ${total} observation${total===1?'':'s'}.`
    : `Reviewed ${input.reviewedNodes} changed piece${input.reviewedNodes===1?'':'s'} of user-visible content. Nothing to flag.`);
  // Humanize reports writing problems; it never claims to know how the text was produced.
  if(total)lines.push('','These are observations about the writing, not claims about how it was produced.');
  const extra=[...input.summary,...input.unplaced];
  if(extra.length){
    lines.push('','<details><summary>Further observations not posted inline</summary>','');
    for(const finding of extra)lines.push(`- \`${finding.node.filePath}:${finding.node.startLine}\` **${CATEGORY_LABEL[finding.category]??finding.category}** — ${finding.explanation}`);
    lines.push('','</details>');
  }
  return lines.join('\n');
}

/**
 * Builds the review. Findings whose line is not part of the diff cannot be commented on
 * inline, so they move to the summary rather than being attached to an unrelated line.
 */
export function buildReview(input:{inline:PublishableFinding[];summary:PublishableFinding[];diff:DiffMap;reviewedNodes:number}):ReviewPayload {
  const comments:ReviewComment[]=[];
  const unplaced:PublishableFinding[]=[];
  for(const finding of input.inline){
    const line=commentableLine(finding,input.diff);
    if(line===null){unplaced.push(finding);continue;}
    comments.push({path:finding.node.filePath,line,side:'RIGHT',body:renderComment(finding)});
  }
  return {event:'COMMENT',body:renderSummary({...input,unplaced}),comments};
}

/**
 * Check conclusion. Subjective findings are advisory by default and must never fail a build;
 * only a deterministic rule the customer configured can do that (ADR-017).
 */
export function buildCheck(findings:readonly PublishableFinding[]):CheckPayload {
  const blocking=findings.filter(finding=>finding.blocking);
  if(blocking.length)return {conclusion:'failure',title:`${blocking.length} policy violation${blocking.length===1?'':'s'}`,summary:'Content violates a configured blocking rule.'};
  if(findings.length)return {conclusion:'neutral',title:`${findings.length} content observation${findings.length===1?'':'s'}`,summary:'Advisory content review feedback; nothing blocks this pull request.'};
  return {conclusion:'success',title:'No content issues found',summary:'No review-worthy content problems were found in the changed user-visible content.'};
}
