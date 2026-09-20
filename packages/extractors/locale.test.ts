import { expect,it } from 'vitest';
import { extract,extractLocale,isLocaleSource } from './src/index.js';

const input=(source:string,filePath:string)=>({repositoryId:'repo',commitSha:'b'.repeat(40),blobSha:'d'.repeat(40),filePath,source});
const texts=(source:string,filePath='locales/en.json')=>extractLocale(input(source,filePath)).map(node=>node.text);

it('recognises a locale resource by convention, and refuses arbitrary data files', () => {
  for(const path of ['locales/en.json','src/i18n/fr.yaml','app/translations/de.json','messages/en-GB.json','en.json'])expect(isLocaleSource(path)).toBe(true);
  for(const path of ['package.json','tsconfig.json','config/database.yml','data/products.json'])expect(isLocaleSource(path)).toBe(false);
  // Configuration can declare one explicitly.
  expect(isLocaleSource('data/copy.json',true)).toBe(true);
});

it('reviews translated values and treats keys as context only', () => {
  const found=texts('{"hero.title":"Unlock unprecedented potential","button.save":"Save changes"}');
  expect(found).toEqual(['Unlock unprecedented potential','Save changes']);
  // The key itself is never reviewed as prose.
  expect(found).not.toContain('hero.title');
});

it('leaves machine values alone however wordy they look', () => {
  const found=texts(JSON.stringify({
    'docs.url':'https://example.com/getting-started','asset.path':'/images/hero.png','theme.color':'#ff0000',
    'api.endpoint':'/v1/users','record.id':'a1b2c3d4-0000','count':'42','hero.title':'Review the content your users read',
  }));
  expect(found).toEqual(['Review the content your users read']);
});

it('maps the source span to the value inside its quotes', () => {
  const source='{"hero.title":"Manage your applications"}';
  const [node]=extractLocale(input(source,'locales/en.json'));
  expect(source.slice(node!.startOffset,node!.endOffset)).toBe('Manage your applications');
  expect(node!.quoteStyle).toBe('double');
  expect(node!.structuralPath).toBe('hero.title');
});

it('walks nested objects and arrays', () => {
  const found=texts(JSON.stringify({onboarding:{steps:['Connect a repository','Open a pull request'],title:'Getting started'}}));
  expect(found).toEqual(['Connect a repository','Open a pull request','Getting started']);
});

it('reads YAML locales and keeps placeholders intact', () => {
  const nodes=extractLocale(input("greeting: Hello {name}\nalerts: You have {{count}} alerts\n",'locales/en.yaml'));
  expect(nodes.map(n=>n.text)).toEqual(['Hello {name}','You have {{count}} alerts']);
  expect(nodes[0]!.placeholders).toEqual(['{name}']);
  expect(nodes[1]!.placeholders).toEqual(['{{count}}']);
});

it('marks an escaped value unsafe for verbatim replacement', () => {
  const [node]=extractLocale(input('{"quote":"She said \\"hello\\" today"}','locales/en.json'));
  expect(node!.text).toBe('She said "hello" today');
  expect(node!.suggestionSafe).toBe(false);
});

it('reports a non-locale data file rather than silently reviewing nothing', () => {
  const result=extract(input('{"name":"my-package","description":"A package that does things"}','package.json'));
  expect(result.nodes).toEqual([]);
  // Silence is the dangerous case; the caller is told why nothing was extracted.
  expect(result.diagnostics).toEqual([{code:'NOT_A_LOCALE_SOURCE',filePath:'package.json'}]);
  expect(extract(input('{"hero.title":"Reviewed"}','locales/en.json')).nodes.map(n=>n.text)).toEqual(['Reviewed']);
});

it('survives malformed input without failing the file', () => {
  expect(extract(input('{ not valid json','locales/en.json')).nodes).toEqual([]);
});
