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
  // `insertNode`/`replaceWith` are the one deliberate exception: highlight.ts uses them to wrap
  // and later unwrap a temporary, click-triggered highlight around text that already exists on
  // the page — never to edit, delete, or replace that text. Every other file, and every other
  // API that would let a rewrite happen (content injection, arbitrary script execution, editing
  // the page directly), stays fully banned everywhere, including in highlight.ts itself.
  const alwaysForbidden = ['execCommand', 'deleteContents', 'contentEditable', 'document.write', 'innerHTML', 'setRangeText', 'surroundContents'];
  const forbiddenOutsideHighlight = ['insertNode', 'replaceWith'];

  it('16. contains no DOM-mutation or content-replacement call anywhere in the extension source', () => {
    for (const [index, source] of sources.entries()) {
      for (const pattern of alwaysForbidden) {
        expect(source, `${sourceFiles[index]} must not use ${pattern}`).not.toContain(pattern);
      }
      if (sourceFiles[index] === 'highlight.ts') continue;
      for (const pattern of forbiddenOutsideHighlight) {
        expect(source, `${sourceFiles[index]} must not use ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it('highlight.ts only ever wraps/unwraps a highlight — it never sets node content directly', () => {
    const highlight = sources[sourceFiles.indexOf('highlight.ts')]!;
    expect(highlight).not.toContain('.nodeValue =');
    expect(highlight).not.toContain('.textContent =');
    expect(highlight).not.toContain('.data =');
  });

  it('the response types carry no replacement/suggestion field to apply', () => {
    const types = sources[sourceFiles.indexOf('types.ts')]!;
    expect(types).not.toContain('replacement');
    expect(types).not.toContain('suggestion');
  });

  it('every script executed in a page is one of exactly two fixed, reviewed functions — nothing page-supplied', () => {
    const popup = sources[sourceFiles.indexOf('popup.ts')]!;
    // executeScript is called exactly twice: once with a literal, hard-coded selection reader,
    // and once with the imported, reviewed highlight function — never a string, never a value
    // derived from the page or from user input.
    expect(popup.match(/executeScript/g)?.length).toBe(2);
    expect(popup).toContain('func: () => window.getSelection()');
    expect(popup).toContain('func: locateAndHighlightInPage');
  });

  it('submits the full original selection, never the truncated on-screen preview', () => {
    const popup = sources[sourceFiles.indexOf('popup.ts')]!;
    // `reviewSelection` must read the untruncated text this popup captured, not the shortened
    // `view.preview` string a user actually sees — regression coverage for a bug where a click
    // handler passed the display preview into the request that gets submitted.
    expect(popup).toContain('selectedText: currentSelectionText');
    expect(popup).not.toContain('runReview(view.preview)');
    expect(popup).not.toMatch(/selectedText:\s*view\.preview/);
  });
});
