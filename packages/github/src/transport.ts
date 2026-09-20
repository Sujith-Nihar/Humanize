import type { CheckPayload,ReviewPayload } from './publisher.js';
import { REVIEW_MARKER } from './publisher.js';

export interface PullRequestTarget { owner:string; repo:string; pullNumber:number; headSha:string; }
export interface GitHubTransport {
  request<T=unknown>(route:string,parameters:Record<string,unknown>):Promise<{data:T}>;
}
export class StaleHeadError extends Error { constructor(readonly current:string){super('STALE_HEAD');this.name='StaleHeadError';} }

export interface PublishOutcome { reviewId:number|null; checkRunId:number; updatedExisting:boolean; }

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

  async publish(target:PullRequestTarget,review:ReviewPayload,check:CheckPayload):Promise<PublishOutcome> {
    const head=await this.currentHead(target);
    if(head!==target.headSha)throw new StaleHeadError(head);

    const {data:checkRun}=await this.transport.request<{id:number}>('POST /repos/{owner}/{repo}/check-runs',{
      owner:target.owner,repo:target.repo,name:'Humanize / Content Review',head_sha:target.headSha,
      status:'completed',conclusion:check.conclusion,completed_at:new Date().toISOString(),
      output:{title:check.title,summary:check.summary},
    });

    // Inline comments belong to a review; without them the summary is a plain issue comment,
    // which can be edited in place on a re-review instead of accumulating.
    if(!review.comments.length){
      const existing=await this.existingReview(target);
      if(existing!==null){
        await this.transport.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
          {owner:target.owner,repo:target.repo,comment_id:existing,body:review.body});
        return {reviewId:null,checkRunId:checkRun.id,updatedExisting:true};
      }
      await this.transport.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {owner:target.owner,repo:target.repo,issue_number:target.pullNumber,body:review.body});
      return {reviewId:null,checkRunId:checkRun.id,updatedExisting:false};
    }

    const {data:posted}=await this.transport.request<{id:number}>('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',{
      owner:target.owner,repo:target.repo,pull_number:target.pullNumber,commit_id:target.headSha,
      event:review.event,body:review.body,comments:review.comments.map(comment=>({path:comment.path,line:comment.line,side:comment.side,body:comment.body})),
    });
    return {reviewId:posted.id,checkRunId:checkRun.id,updatedExisting:false};
  }
}
