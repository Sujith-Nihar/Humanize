import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, 'src');
const sourceFiles = readdirSync(SRC_DIR).filter(name => name.endsWith('.ts'));
const sources = sourceFiles.map(name => readFileSync(join(SRC_DIR, name), 'utf8'));

/**
 * This is a negative property — "the extension never rewrites page content" — which has no
 * positive behavior to invoke and assert on. The most direct way to test the absence of a
 * capability this codebase has decided never to build is to confirm none of the DOM-mutating or
 * script-injecting APIs that a rewrite would require appear anywhere in the source at all.
 */
describe('no automatic rewriting or replacement', () => {
  const forbidden = [
    'execCommand', 'insertNode', 'deleteContents', 'contentEditable', 'document.write',
    'innerHTML', 'setRangeText', 'replaceWith', 'surroundContents',
  ];

  it('16. contains no DOM-mutation or content-replacement call anywhere in the extension source', () => {
    for (const [index, source] of sources.entries()) {
      for (const pattern of forbidden) {
        expect(source, `${sourceFiles[index]} must not use ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it('the response types carry no replacement/suggestion field to apply', () => {
    const types = sources[sourceFiles.indexOf('types.ts')]!;
    expect(types).not.toContain('replacement');
    expect(types).not.toContain('suggestion');
  });

  it('the only script executed in a page is the fixed, reviewed selection reader — nothing page-supplied', () => {
    const popup = sources[sourceFiles.indexOf('popup.ts')]!;
    // executeScript is called exactly once, with a literal, hard-coded function — never a
    // string, never a value derived from the page or from user input.
    expect(popup.match(/executeScript/g)?.length).toBe(1);
    expect(popup).toContain('func: () => window.getSelection()');
  });
});
