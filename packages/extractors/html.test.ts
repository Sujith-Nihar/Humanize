import { expect,it } from 'vitest';
import { LIMITS } from '@humanize/domain';
import { extract,extractHtml } from './src/index.js';

const input=(source:string,filePath='index.html')=>({repositoryId:'repo',commitSha:'b'.repeat(40),blobSha:'d'.repeat(40),filePath,source});
const texts=(source:string)=>extractHtml(input(source)).map(node=>node.text);
const at=(source:string,text:string)=>extractHtml(input(source)).find(node=>node.text===text)!;

it('extracts what a reader sees and nothing else', () => {
  const source=`<h1>Content review for product teams</h1>
<p>Humanize checks user-visible text.</p>
<script>const message="this is code, not prose";</script>
<style>.hero::after{content:"decorative"}</style>
<template><p>never rendered</p></template>`;
  expect(texts(source)).toEqual(['Content review for product teams','Humanize checks user-visible text.']);
});

it('reads accessibility and visible attributes but never machine attributes', () => {
  const source=`<img src="/assets/hero-image-final-v2.png" alt="Humanize review summary" class="hero large" />
<a href="https://example.com/pricing" title="See pricing">Pricing</a>
<input placeholder="Work email" name="email_address" type="email" />`;
  const found=texts(source);
  expect(found).toContain('Humanize review summary');
  expect(found).toContain('See pricing');
  expect(found).toContain('Work email');
  expect(found).toContain('Pricing');
  // A URL, a class list and a field name are not prose however wordy they look.
  for(const machine of ['/assets/hero-image-final-v2.png','hero large','https://example.com/pricing','email_address','email'])expect(found).not.toContain(machine);
});

it('maps source ranges exactly onto the original document', () => {
  const source=`<h1>Manage your applications</h1>`;
  const node=at(source,'Manage your applications');
  expect(source.slice(node.startOffset,node.endOffset)).toBe('Manage your applications');
  expect(node.startLine).toBe(1);
  const multiline=`<p>\n  Second line text\n</p>`;
  const second=at(multiline,'Second line text');
  expect(multiline.slice(second.startOffset,second.endOffset)).toBe('Second line text');
  expect(second.startLine).toBe(2);
});

it('marks entity-bearing content unsafe to replace, because source and rendered text differ', () => {
  const node=at('<p>Terms &amp; conditions apply</p>','Terms & conditions apply');
  expect(node.text).toBe('Terms & conditions apply');
  // Replacing the raw span verbatim would destroy the encoding.
  expect(node.suggestionSafe).toBe(false);
  expect(node.segments[0]!.encoding).toBe('entity');
  expect(at('<p>Plain wording</p>','Plain wording').suggestionSafe).toBe(true);
});

it('records the quote style so an attribute can be re-encoded safely', () => {
  expect(at(`<img alt="double quoted" src="a.png"/>`,'double quoted').quoteStyle).toBe('double');
  expect(at(`<img alt='single quoted' src='a.png'/>`,'single quoted').quoteStyle).toBe('single');
});

it('classifies headings, links and accessibility text by their element', () => {
  const nodes=extractHtml(input('<h2>Getting started</h2><a href="/docs">Read the docs</a><img src="a.png" alt="Screenshot"/>'));
  expect(nodes.find(n=>n.text==='Getting started')!.kind).toBe('heading');
  expect(nodes.find(n=>n.text==='Read the docs')!.kind).toBe('link');
  expect(nodes.find(n=>n.text==='Screenshot')!.kind).toBe('accessibility');
});

it('is reachable through the extractor entry point and survives malformed markup', () => {
  expect(extract(input('<h1>Reachable</h1>')).nodes.map(n=>n.text)).toEqual(['Reachable']);
  // Browsers recover from broken markup, so the extractor must not fail the file.
  expect(()=>extract(input('<h1>Unclosed <p>nested <span>deep'))).not.toThrow();
  expect(extract(input('')).nodes).toEqual([]);
});

it('still extracts an attribute whose value contains an entity, marking it unsafe', () => {
  // Searching the source for the decoded value would find nothing and drop the attribute,
  // leaving that content silently unreviewed.
  const node=at('<img src="a.png" alt="Terms &amp; conditions" />','Terms & conditions');
  expect(node.text).toBe('Terms & conditions');
  expect(node.suggestionSafe).toBe(false);
  expect('<img src="a.png" alt="Terms &amp; conditions" />'.slice(node.startOffset,node.endOffset)).toBe('Terms &amp; conditions');
});

it('stops at the per-file node cap and says so', () => {
  const many=Array.from({length:LIMITS.nodesPerFile+500},(_,i)=>`<p>Sentence ${i}</p>`).join('');
  const result=extract(input(many));
  // One file must not consume a job's time budget, and truncation is reported rather
  // than leaving the caller to assume full coverage.
  expect(result.nodes.length).toBe(LIMITS.nodesPerFile);
  expect(result.diagnostics).toContainEqual({code:'NODE_LIMIT_REACHED',filePath:'index.html'});
  expect(extract(input('<p>One</p>')).diagnostics).toEqual([]);
});
