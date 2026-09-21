import { expect,it,vi } from 'vitest';
import { REVIEW_MARKER,ReviewPublisher,StaleHeadError } from './src/index.js';
import type { GitHubTransport } from './src/index.js';

const target={owner:'acme',repo:'site',pullNumber:7,headSha:'b'.repeat(40)};
const review={event:'COMMENT' as const,body:`${REVIEW_MARKER}\nSummary`,comments:[{path:'app/page.tsx',line:12,side:'RIGHT' as const,body:'Observation'}]};
const check={conclusion:'neutral' as const,title:'1 content observation',summary:'Advisory'};
const fake=(routes:Record<string,unknown>)=>{
  const calls:{route:string;parameters:Record<string,unknown>}[]=[];
  const transport:GitHubTransport={request:vi.fn(async(route:string,parameters:Record<string,unknown>)=>{
    calls.push({route,parameters});
    return {data:(routes[route]??{}) as never};
  })};
  return {transport,calls};
};
const defaults={'GET /repos/{owner}/{repo}/pulls/{pull_number}':{head:{sha:'b'.repeat(40)}},
  'POST /repos/{owner}/{repo}/check-runs':{id:555},
  'GET /repos/{owner}/{repo}/issues/{issue_number}/comments':[],
  'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews':{id:999}};

it('publishes a grouped review and a check run for the reviewed head', async () => {
  const {transport,calls}=fake(defaults);
  const outcome=await new ReviewPublisher(transport).publish(target,review,check);
  expect(outcome).toMatchObject({reviewId:999,checkRunId:555,updatedExisting:false});
  const posted=calls.find(call=>call.route==='POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews')!;
  expect(posted.parameters).toMatchObject({event:'COMMENT',commit_id:target.headSha});
  const checkRun=calls.find(call=>call.route==='POST /repos/{owner}/{repo}/check-runs')!;
  expect(checkRun.parameters).toMatchObject({name:'Humanize / Content Review',conclusion:'neutral',head_sha:target.headSha});
});

it('refuses to publish findings computed for a superseded commit', async () => {
  const {transport,calls}=fake({...defaults,'GET /repos/{owner}/{repo}/pulls/{pull_number}':{head:{sha:'c'.repeat(40)}}});
  await expect(new ReviewPublisher(transport).publish(target,review,check)).rejects.toBeInstanceOf(StaleHeadError);
  // Nothing at all is written: the author must not be told about wording they already changed.
  expect(calls.map(call=>call.route)).toEqual(['GET /repos/{owner}/{repo}/pulls/{pull_number}']);
});

it('edits its own previous summary instead of adding another when there is nothing inline', async () => {
  const existing={...defaults,'GET /repos/{owner}/{repo}/issues/{issue_number}/comments':[{id:42,body:'unrelated'},{id:77,body:`${REVIEW_MARKER} previous`}]};
  const {transport,calls}=fake(existing);
  const outcome=await new ReviewPublisher(transport).publish(target,{...review,comments:[]},check);
  expect(outcome).toMatchObject({reviewId:null,updatedExisting:true});
  const patched=calls.find(call=>call.route==='PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}')!;
  expect(patched.parameters).toMatchObject({comment_id:77});
  expect(calls.some(call=>call.route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments')).toBe(false);
});

it('creates a summary comment the first time', async () => {
  const {transport,calls}=fake(defaults);
  const outcome=await new ReviewPublisher(transport).publish(target,{...review,comments:[]},check);
  expect(outcome).toMatchObject({reviewId:null,updatedExisting:false});
  expect(calls.some(call=>call.route==='POST /repos/{owner}/{repo}/issues/{issue_number}/comments')).toBe(true);
});

it('reports a failing check only for the conclusion it was given', async () => {
  const {transport,calls}=fake(defaults);
  await new ReviewPublisher(transport).publish(target,review,{conclusion:'failure',title:'1 policy violation',summary:'Blocked'});
  expect(calls.find(call=>call.route==='POST /repos/{owner}/{repo}/check-runs')!.parameters).toMatchObject({conclusion:'failure'});
});

it('removes a stale no-findings comment when a review supersedes it',async()=>{
  // A run that found nothing leaves a standalone "Nothing to flag" comment. A later run with
  // findings posts a review; leaving the old comment shows a reader both at once, on the same
  // commit. Observed on a live pull request.
  const calls:{route:string;parameters:Record<string,unknown>}[]=[];
  const transport={request:async(route:string,parameters:Record<string,unknown>)=>{
    calls.push({route,parameters});
    if(route.startsWith('GET /repos/{owner}/{repo}/pulls/{pull_number}'))return {data:{head:{sha:'c'.repeat(40)}}};
    if(route.startsWith('GET /repos/{owner}/{repo}/issues/{issue_number}/comments'))
      return {data:[{id:4242,body:`${REVIEW_MARKER}\nNothing to flag.`}]};
    return {data:{id:7}};
  }};
  const outcome=await new ReviewPublisher(transport as never).publish(
    {owner:'acme',repo:'site',pullNumber:1,headSha:'c'.repeat(40)},
    {event:'COMMENT',body:'summary',comments:[{path:'a.tsx',line:3,side:'RIGHT',body:'finding'}]},
    {conclusion:'neutral',title:'1 observation',summary:'advisory'});
  expect(outcome.supersededCommentId).toBe(4242);
  const deleted=calls.find(c=>c.route.startsWith('DELETE /repos/{owner}/{repo}/issues/comments'));
  expect(deleted?.parameters.comment_id).toBe(4242);
});

it('leaves comments that are not its own alone',async()=>{
  const calls:string[]=[];
  const transport={request:async(route:string)=>{
    calls.push(route);
    if(route.startsWith('GET /repos/{owner}/{repo}/pulls/{pull_number}'))return {data:{head:{sha:'c'.repeat(40)}}};
    if(route.startsWith('GET /repos/{owner}/{repo}/issues/{issue_number}/comments'))
      return {data:[{id:99,body:'a human wrote this'}]};
    return {data:{id:7}};
  }};
  const outcome=await new ReviewPublisher(transport as never).publish(
    {owner:'acme',repo:'site',pullNumber:1,headSha:'c'.repeat(40)},
    {event:'COMMENT',body:'summary',comments:[{path:'a.tsx',line:3,side:'RIGHT',body:'finding'}]},
    {conclusion:'neutral',title:'1 observation',summary:'advisory'});
  expect(outcome.supersededCommentId).toBeUndefined();
  expect(calls.some(r=>r.startsWith('DELETE'))).toBe(false);
});
