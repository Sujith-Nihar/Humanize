import { expect,it } from 'vitest';
import { extract,placeholders } from './src/index.js';
const base={repositoryId:'repo',commitSha:'a'.repeat(40),blobSha:'b'.repeat(40)};

it('extracts visible JSX with deterministic source ranges and ignores internal strings',()=>{
  const source=`const endpoint='/api/users';\r\nconst title='Welcome';\r\nconst ui=<><h1>😀 Hello &amp; welcome</h1><Input placeholder="Work email"/><p>{title}</p></>;\r\ntoast('Saved'); console.log('internal');`;
  const result=extract({...base,filePath:'app.tsx',source});
  expect(result.diagnostics).toEqual([]);
  expect(result.nodes.map(n=>n.text)).toEqual(expect.arrayContaining(['😀 Hello & welcome','Work email','Welcome','Saved']));
  expect(result.nodes).toHaveLength(4);
  const heading=result.nodes.find(n=>n.kind==='heading')!;expect(source.slice(heading.startOffset,heading.endOffset)).toBe('😀 Hello &amp; welcome');expect(heading.startLine).toBe(3);
  expect(extract({...base,filePath:'app.tsx',source})).toEqual(result);
});
it('does not resolve shadowed or mutable constants',()=>{
  const source=`let title='mutable';const x=<p>{title}</p>;function C(title:string){return <p>{title}</p>}`;
  expect(extract({...base,filePath:'app.tsx',source}).nodes).toHaveLength(0);
});
it('preserves Markdown prose mappings and marks complex markup comment-only',()=>{
  const result=extract({...base,filePath:'README.md',source:'# Heading\n\nRead the **important** [guide](https://example.test).\n\n```js\nconst secret="not prose";\n```\n'});
  expect(result.nodes.map(n=>n.text)).toEqual(['Heading','Read the important guide.']);
  expect(result.nodes[1]?.suggestionSafe).toBe(false);
});
it('isolates malformed input and preserves placeholders',()=>{
  expect(extract({...base,filePath:'a.tsx',source:'<h1>'}).diagnostics[0]?.code).toBe('PARSE_FAILURE');
  expect(placeholders('Hello {name}, {{count}} alerts and %s files')).toEqual(['{name}','{{count}}','%s']);
});
