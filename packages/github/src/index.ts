import type { FileDiff } from '@humanize/domain';
export { verifyWebhook,normalizeWebhook,eventIntent } from './webhook.js';
export { GitHubTokenBroker,githubClient } from './client.js';
export { GitHubFileSource,MAX_TRUSTED_FILE_BYTES } from './files.js';
export type { TrustedFileRequest } from './files.js';

export function parseFileDiff(oldPath:string|null,newPath:string|null,patch:string):FileDiff {
  const result:FileDiff={oldPath,newPath,addedLines:[],deletedLines:[],hunks:[]};
  let old=0,next=0,active=false,remainingOld=0,remainingNew=0;
  for(const line of patch.split('\n')) {
    const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if(header){old=Number(header[1]);next=Number(header[3]);remainingOld=header[2]===undefined?1:Number(header[2]);remainingNew=header[4]===undefined?1:Number(header[4]);result.hunks.push({oldStart:old,oldCount:remainingOld,newStart:next,newCount:remainingNew});active=true;continue;}
    if(!active||(!remainingOld&&!remainingNew)||line.startsWith('\\'))continue;
    if(line.startsWith('+')){if(remainingNew<=0)throw Error('INVALID_DIFF');result.addedLines.push(next++);remainingNew--;}
    else if(line.startsWith('-')){if(remainingOld<=0)throw Error('INVALID_DIFF');result.deletedLines.push(old++);remainingOld--;}
    else if(line.startsWith(' ')){if(remainingNew<=0||remainingOld<=0)throw Error('INVALID_DIFF');old++;next++;remainingOld--;remainingNew--;}
    else throw Error('INVALID_DIFF');
  }
  if(remainingOld||remainingNew)throw Error('TRUNCATED_DIFF');
  return result;
}

export function representableRange(diff:FileDiff,start:number,end:number):boolean {
  return !!diff.newPath&&start>0&&end>=start&&diff.addedLines.some(line=>line>=start&&line<=end)
    &&diff.hunks.some(h=>start>=h.newStart&&end<h.newStart+h.newCount);
}

export { buildReview,buildCheck,renderComment,renderSummary,commentableLine,REVIEW_MARKER,commentMarker } from './publisher.js';
export type { CheckConclusion,CheckPayload,PublishableFinding,ReviewComment,ReviewPayload } from './publisher.js';
export { ReviewPublisher,StaleHeadError } from './transport.js';
export { fetchDiffMap } from './diff-map.js';
export type { GitHubTransport,PublishOutcome,PullRequestTarget } from './transport.js';
