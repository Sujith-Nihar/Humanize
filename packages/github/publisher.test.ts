import { expect,it } from 'vitest';
import type { ContentNode,DiffMap,ValidatedFinding } from '@humanize/domain';
import { REVIEW_MARKER,buildCheck,buildReview,commentMarker,renderComment } from './src/index.js';

const text='Unlock unprecedented potential with our cutting-edge platform.';
let counter=0;
const node=(overrides:Partial<ContentNode>={}):ContentNode=>({
  id:`node-${++counter}`,repositoryId:'repo',commitSha:'b'.repeat(40),filePath:'app/page.tsx',blobSha:'d'.repeat(40),parser:'babel',parserVersion:'1',
  startLine:12,endLine:12,startOffset:0,endOffset:text.length,text,normalizedText:text.toLowerCase(),kind:'marketing',sourceKind:'jsx_text',
  dynamic:false,visibilityConfidence:1,placeholders:[],stableKey:`stable-${counter}`,mappingVersion:1,segments:[],extractionConfigHash:'config',suggestionSafe:true,...overrides,
});
const finding=(overrides:Partial<ValidatedFinding>={}):ValidatedFinding=>({
  nodeId:'node-1',category:'ai_like_generic',severity:'minor',confidence:0.95,exactText:'Unlock unprecedented potential',
  explanation:'Broad promotional wording with little product-specific information.',evidence:[],replacement:null,requiresVerification:true,
  fingerprint:`fp-${++counter}`,node:node(),evidenceRecords:[],deterministic:false,blocking:false,verificationConfidence:0.95,...overrides,
});
const diff=(lines:number[],path='app/page.tsx'):DiffMap=>({repositoryId:'repo',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),mergeBaseSha:'a'.repeat(40),
  files:[{oldPath:path,newPath:path,addedLines:lines,deletedLines:[],hunks:[{oldStart:1,oldCount:20,newStart:1,newCount:20}]}]});

it('posts an advisory comment review on the exact changed line', () => {
  const item=finding();
  const review=buildReview({inline:[item],summary:[],diff:diff([12]),reviewedNodes:1});
  // Humanize advises; it never approves or requests changes.
  expect(review.event).toBe('COMMENT');
  expect(review.comments).toEqual([expect.objectContaining({path:'app/page.tsx',line:12,side:'RIGHT'})]);
  expect(review.comments[0]!.body).toContain(commentMarker(item.fingerprint));
  expect(review.comments[0]!.body).toContain('Generic / AI-like wording');
  expect(review.body).toContain(REVIEW_MARKER);
});

it('never claims the content was machine authored', () => {
  const review=buildReview({inline:[finding()],summary:[],diff:diff([12]),reviewedNodes:1});
  const published=`${review.body}\n${review.comments.map(c=>c.body).join('\n')}`.toLowerCase();
  for(const forbidden of ['ai-generated','ai generated','written by ai','machine authored','chatgpt','% ai'])expect(published).not.toContain(forbidden);
  expect(review.body).toContain('not claims about how it was produced');
});

it('moves a finding to the summary when its line is not part of the diff', () => {
  const untouched=finding({node:node({startLine:99,endLine:99})});
  const review=buildReview({inline:[untouched],summary:[],diff:diff([12]),reviewedNodes:1});
  // Attaching it to an unrelated line would comment on code the author did not touch.
  expect(review.comments).toEqual([]);
  expect(review.body).toContain('app/page.tsx:99');
  const missingFile=buildReview({inline:[finding({node:node({filePath:'app/other.tsx'})})],summary:[],diff:diff([12]),reviewedNodes:1});
  expect(missingFile.comments).toEqual([]);
});

it('lists budgeted-out findings in a collapsed summary section', () => {
  const review=buildReview({inline:[finding()],summary:[finding({explanation:'Second observation.'})],diff:diff([12]),reviewedNodes:2});
  expect(review.body).toContain('<details><summary>Further observations not posted inline</summary>');
  expect(review.body).toContain('Second observation.');
  expect(review.comments).toHaveLength(1);
});

it('says so plainly when there is nothing to flag', () => {
  const review=buildReview({inline:[],summary:[],diff:diff([12]),reviewedNodes:3});
  expect(review.body).toContain('Nothing to flag.');
  expect(review.comments).toEqual([]);
});

it('renders a native suggestion block when a safe replacement exists', () => {
  const body=renderComment(finding({suggestion:{path:'app/page.tsx',startLine:12,endLine:12,replacement:'Manage your AI applications',sourceHash:'h',headSha:'b'.repeat(40)}}));
  expect(body).toContain('```suggestion\nManage your AI applications\n```');
});

it('never fails a check for subjective findings, only for a configured rule', () => {
  expect(buildCheck([])).toMatchObject({conclusion:'success'});
  // Advisory by default: AI-like wording alone must not block a merge.
  expect(buildCheck([finding(),finding({severity:'major'})])).toMatchObject({conclusion:'neutral'});
  expect(buildCheck([finding({deterministic:true,blocking:true,category:'terminology'})])).toMatchObject({conclusion:'failure'});
});
