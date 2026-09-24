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
  // Painting the highlight via the CSS Custom Highlight API (see highlight.ts) means none of
  // these DOM-mutation/content-injection primitives are needed anywhere in this extension at
  // all — the highlight is a pure rendering effect, never a node the page's own tree gains,
  // loses, or has split. An earlier implementation used `insertNode`/`replaceWith` to wrap and
  // unwrap the highlighted text; that approach was replaced after manual testing showed it could
  // subtly shift the page's live selection on repeated highlights (see highlight.ts's comment).
  const forbidden = [
    'execCommand', 'insertNode', 'deleteContents', 'contentEditable', 'document.write',
    'innerHTML', 'setRangeText', 'replaceWith', 'surroundContents', 'extractContents',
  ];

  it('16. contains no DOM-mutation or content-replacement call anywhere in the extension source', () => {
    for (const [index, source] of sources.entries()) {
      for (const pattern of forbidden) {
        expect(source, `${sourceFiles[index]} must not use ${pattern}`).not.toContain(pattern);
      }
    }
  });

  it('highlight.ts only ever registers/clears a CSS highlight — it never sets an existing text node\'s content', () => {
    const highlight = sources[sourceFiles.indexOf('highlight.ts')]!;
    expect(highlight).not.toContain('.nodeValue =');
    expect(highlight).not.toContain('.data =');
    // The one exception: `style.textContent = ...` sets the CSS rule text of a `<style>` element
    // this function creates itself — never the text of a node already on the page.
    expect(highlight.match(/\w+\.textContent\s*=/g)).toEqual(['style.textContent =']);
  });

  it('the response types carry no replacement/suggestion field to apply', () => {
    const types = sources[sourceFiles.indexOf('types.ts')]!;
    expect(types).not.toContain('replacement');
    expect(types).not.toContain('suggestion');
  });

  it('every script executed in a page is one of exactly three fixed, reviewed functions — nothing page-supplied', () => {
    const popup = sources[sourceFiles.indexOf('popup.ts')]!;
    // executeScript is called exactly three times: a literal, hard-coded selection reader, and
    // the imported, reviewed highlight/clear-highlight functions — never a string, never a value
    // derived from the page or from user input.
    expect(popup.match(/executeScript/g)?.length).toBe(3);
    expect(popup).toContain('func: () => window.getSelection()');
    expect(popup).toContain('func: locateAndHighlightInPage');
    expect(popup).toContain('func: clearHighlightInPage');
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
