import type { CheckPayload,ReviewPayload } from './publisher.js';
import { REVIEW_MARKER } from './publisher.js';

/**
 * `runId` identifies one review attempt across retries. It is what lets a retry recognise work a
 * previous attempt already posted, so it is required rather than optional.
 */
export interface PullRequestTarget { owner:string; repo:string; pullNumber:number; headSha:string; runId:string; }
export interface GitHubTransport {
  request<T=unknown>(route:string,parameters:Record<string,unknown>):Promise<{data:T}>;
}
export class StaleHeadError extends Error { constructor(readonly current:string){super('STALE_HEAD');this.name='StaleHeadError';} }

export const CHECK_NAME='Humanize / Content Review';
/** Marks the review a run posted, so a retry can find it rather than post it again. */
export const runMarker=(runId:string):string=>`<!-- humanize:run:${runId} -->`;
const MAX_REVIEW_PAGES=10;

export interface PublishOutcome { reviewId:number|null; checkRunId:number; updatedExisting:boolean;
  /** True when a previous attempt of this run had already posted and this one completed it. */
  resumed:boolean;
  /** A standalone summary comment this review replaced, removed so the two cannot contradict. */
  supersededCommentId?:number; }

/**
 * Posts a review to GitHub. The head is re-read immediately before writing: a review computed
 * for a superseded commit must never appear as current feedback, because the author would be
 * told about wording they have already changed (INV-010).
 */
export class ReviewPublisher {
  constructor(private readonly transport:GitHubTransport){}

  private async currentHead(target:PullRequestTarget):Promise<string> {
    const {data}=await this.transport.request<{head:{sha:string}}>('GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {owner:target.owner,repo:target.repo,pull_number:target.pullNumber});
    return data.head.sha;
  }

  /** Existing Humanize comments, recognised by marker, so a re-review updates rather than piles up. */
  private async existingReview(target:PullRequestTarget):Promise<number|null> {
    const {data}=await this.transport.request<{id:number;body?:string}[]>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {owner:target.owner,repo:target.repo,issue_number:target.pullNumber,per_page:100});
    return data.find(comment=>comment.body?.includes(REVIEW_MARKER))?.id??null;
  }

  /** The check run a previous attempt of this run created, recognised by its external id. */
  private async existingCheckRun(target:PullRequestTarget):Promise<number|null> {
    const {data}=await this.transport.request<{check_runs?:{id:number;external_id?:string|null}[]}>('GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      {owner:target.owner,repo:target.repo,ref:target.headSha,check_name:CHECK_NAME,per_page:100});
    return data.check_runs?.find(run=>run.external_id===target.runId)?.id??null;
  }

  /** The review a previous attempt of this run posted, recognised by its run marker. */
  private async existingRunReview(target:PullRequestTarget):Promise<number|null> {
    const marker=runMarker(target.runId);
    for(let page=1;page<=MAX_REVIEW_PAGES;page++){
      const {data}=await this.transport.request<{id:number;body?:string|null}[]>('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        {owner:target.owner,repo:target.repo,pull_number:target.pullNumber,per_page:100,page});
      const found=data.find(entry=>entry.body?.includes(marker));
      if(found)return found.id;
      if(data.length<100)break;
    }
    return null;
  }

  /**
   * Publishes a run's check and review, safely repeatable. The queue retries a publication that
   * failed part-way, and a retry must finish the work rather than repeat it: a second check run
   * for one head, or a second copy of every inline comment, is exactly the noise that gets a
   * reviewer uninstalled. What was already posted is read back from GitHub itself, so a crash
   * between GitHub accepting a post and anything being recorded here is covered too.
   */
  async publish(target:PullRequestTarget,review:ReviewPayload,check:CheckPayload):Promise<PublishOutcome> {
    const head=await this.currentHead(target);
    if(head!==target.headSha)throw new StaleHeadError(head);

    const output={status:'completed',conclusion:check.conclusion,completed_at:new Date().toISOString(),output:{title:check.title,summary:check.summary}};
    const priorCheck=await this.existingCheckRun(target);
    const checkRun=priorCheck!==null
      ?(await this.transport.request<{id:number}>('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
          {owner:target.owner,repo:target.repo,check_run_id:priorCheck,...output})).data
      :(await this.transport.request<{id:number}>('POST /repos/{owner}/{repo}/check-runs',
          {owner:target.owner,repo:target.repo,name:CHECK_NAME,head_sha:target.headSha,external_id:target.runId,...output})).data;
    const checkRunId=checkRun.id??priorCheck!;

    // Inline comments belong to a review; without them the summary is a plain issue comment,
    // which can be edited in place on a re-review instead of accumulating.
    if(!review.comments.length){
      const existing=await this.existingReview(target);
      if(existing!==null){
        await this.transport.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
          {owner:target.owner,repo:target.repo,comment_id:existing,body:review.body});
        return {reviewId:null,checkRunId,updatedExisting:true,resumed:priorCheck!==null};
      }
      await this.transport.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {owner:target.owner,repo:target.repo,issue_number:target.pullNumber,body:review.body});
      return {reviewId:null,checkRunId,updatedExisting:false,resumed:priorCheck!==null};
    }

    // A review this run already posted is not posted again; its inline comments are already there.
    const priorReview=await this.existingRunReview(target);
    const reviewId=priorReview??(await this.transport.request<{id:number}>('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',{
      owner:target.owner,repo:target.repo,pull_number:target.pullNumber,commit_id:target.headSha,
      event:review.event,body:`${review.body}\n${runMarker(target.runId)}`,
      comments:review.comments.map(comment=>({path:comment.path,line:comment.line,side:comment.side,body:comment.body})),
    })).data.id;

    // An earlier run with no findings leaves a standalone summary comment. This review now
    // carries the current summary, so that comment is stale: leaving it in place shows the
    // reader "Nothing to flag" directly above a review raising findings on the same commit.
    // Only a comment bearing this product's own marker is ever removed.
    const superseded=await this.existingReview(target);
    if(superseded!==null){
      await this.transport.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}',
        {owner:target.owner,repo:target.repo,comment_id:superseded});
    }
    return {reviewId,checkRunId,updatedExisting:false,resumed:priorCheck!==null||priorReview!==null,...(superseded!==null?{supersededCommentId:superseded}:{})};
  }
}
