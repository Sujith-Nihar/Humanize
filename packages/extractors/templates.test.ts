import { expect,it } from 'vitest';
import { extract,extractCss,extractSvelte,extractVue } from './src/index.js';

const input=(source:string,filePath:string)=>({repositoryId:'repo',commitSha:'b'.repeat(40),blobSha:'d'.repeat(40),filePath,source});
const spans=(nodes:{text:string;startOffset:number;endOffset:number}[],source:string)=>
  nodes.every(node=>source.slice(node.startOffset,node.endOffset)===node.text);

it('extracts Vue static template text and visible attributes', () => {
  const source=`<template>
  <section>
    <h1>Review the content your users read</h1>
    <img src="hero.png" alt="Humanize review summary" />
    <input placeholder="Work email" name="email" />
  </section>
</template>

<script setup>
const internalStatus = 'active';
</script>

<style>
.hero { color: red; }
</style>
`;
  const nodes=extractVue(input(source,'Hero.vue'));
  const texts=nodes.map(node=>node.text);
  expect(texts).toContain('Review the content your users read');
  expect(texts).toContain('Humanize review summary');
  expect(texts).toContain('Work email');
  // Script and style contents are code, not prose, and machine attributes are not text.
  for(const excluded of ['active','hero.png','email','color: red;'])expect(texts).not.toContain(excluded);
  // Offsets are relative to the original file, not to the extracted template block.
  expect(spans(nodes,source)).toBe(true);
});

it('never evaluates a Vue interpolation or a bound attribute', () => {
  const source=`<template><h1>{{ product.title }}</h1><img :alt="computedAlt" src="a.png"/></template>`;
  const texts=extractVue(input(source,'Dynamic.vue')).map(node=>node.text);
  // Resolving either would mean executing customer code.
  expect(texts).not.toContain('product.title');
  expect(texts).not.toContain('computedAlt');
});

it('extracts Svelte static template text and attributes', () => {
  const source=`<script>
  let count = 0;
  const endpoint = '/api/users';
</script>

<h1>Manage your applications</h1>
<img src="hero.png" alt="Dashboard overview" />
<button>Save changes</button>

<style>
  h1 { font-size: 2rem; }
</style>
`;
  const nodes=extractSvelte(input(source,'Page.svelte'));
  const texts=nodes.map(node=>node.text);
  expect(texts).toContain('Manage your applications');
  expect(texts).toContain('Dashboard overview');
  expect(texts).toContain('Save changes');
  for(const excluded of ['/api/users','hero.png','font-size: 2rem;'])expect(texts).not.toContain(excluded);
  expect(spans(nodes,source)).toBe(true);
});

it('distinguishes static Svelte content from interpolated content', () => {
  const source=`<h1>{title}</h1><img alt="Static description" src="a.png"/><p alt={dynamicAlt}>text</p>`;
  const texts=extractSvelte(input(source,'Mixed.svelte')).map(node=>node.text);
  expect(texts).toContain('Static description');
  // An interpolated attribute has no literal value to review.
  expect(texts).not.toContain('dynamicAlt');
  expect(texts).not.toContain('{title}');
});

it('extracts only static pseudo-element content from CSS', () => {
  const source=`.badge::after { content: "New feature"; }
.icon::before { content: ""; }
.counter::before { content: counter(step); }
.attr::after { content: attr(data-label); }
.hidden { content: "not a pseudo element"; }
.quote::before { content: open-quote; }
`;
  const nodes=extractCss(input(source,'styles.css'));
  expect(nodes.map(node=>node.text)).toEqual(['New feature']);
  expect(nodes[0]!.kind).toBe('css_generated');
  // Generated content is real but poor for accessibility, so it is reviewed conservatively.
  expect(nodes[0]!.visibilityConfidence).toBeLessThan(1);
  expect(source.slice(nodes[0]!.startOffset,nodes[0]!.endOffset)).toBe('New feature');
});

it('marks escaped CSS content unsafe to replace', () => {
  const nodes=extractCss(input('.badge::after { content: "Caf\\\\e9 open"; }','styles.css'));
  expect(nodes[0]?.suggestionSafe).toBe(false);
});

it('routes every template format through the extractor entry point', () => {
  expect(extract(input('<template><h1>Vue heading</h1></template>','A.vue')).nodes.map(n=>n.text)).toEqual(['Vue heading']);
  expect(extract(input('<h1>Svelte heading</h1>','A.svelte')).nodes.map(n=>n.text)).toEqual(['Svelte heading']);
  expect(extract(input('.a::after{content:"Generated"}','a.css')).nodes.map(n=>n.text)).toEqual(['Generated']);
});

it('survives malformed templates without failing the file', () => {
  for(const [source,path] of [['<template><h1>unclosed','A.vue'],['<h1>unclosed {','A.svelte'],['.a { content: ','a.css']] as const){
    expect(()=>extract(input(source,path))).not.toThrow();
  }
});
