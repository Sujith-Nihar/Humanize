import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightArgsFor, locateAndHighlightInPage } from './src/highlight.js';
import type { BrowserFinding } from './src/types.js';

// Plain-object stand-ins for DOM nodes: real Text/Element nodes satisfy this same shape
// (nodeType 3 for text, childNodes for elements), so the exact traversal logic under test here
// runs identically against a real page. No jsdom or other DOM dependency is added for this.
function textNode(value: string) {
  return { nodeType: 3, nodeValue: value };
}
function element(children: unknown[]) {
  return { nodeType: 1, childNodes: children };
}

/** A fake `document.createRange()` result: records what the implementation does to it. */
function createFakeDomRange() {
  return {
    setStart: vi.fn(),
    setEnd: vi.fn(),
    extractContents: vi.fn(() => ({ fragment: true })),
    insertNode: vi.fn(),
  };
}

/** A fake `document.createElement('mark')` result. */
function createFakeMarkElement() {
  const children: unknown[] = [];
  return {
    className: '',
    style: {} as Record<string, string>,
    appendChild: vi.fn((child: unknown) => { children.push(child); }),
    scrollIntoView: vi.fn(),
    replaceWith: vi.fn(),
    get childNodes() { return children; },
  };
}

interface FakeLiveRange {
  startContainer: unknown; startOffset: number;
  endContainer: unknown; endOffset: number;
  commonAncestorContainer: unknown;
}
function fakeSelection(text: string, range: FakeLiveRange | null) {
  return {
    rangeCount: range ? 1 : 0,
    isCollapsed: !range,
    toString: () => text,
    getRangeAt: () => range as FakeLiveRange,
  };
}

const CLEANUP_KEY = '__humanizeHighlightCleanup__';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe('locateAndHighlightInPage', () => {
  it('1. locates and highlights an exact range inside a single text node', () => {
    const node = textNode('Hello world');
    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection('Hello world', {
        startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
      }),
    };
    const domRange = createFakeDomRange();
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => domRange, createElement: () => mark };

    const result = locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' });

    expect(result).toEqual({ ok: true });
    expect(domRange.setStart).toHaveBeenCalledWith(node, 6);
    expect(domRange.setEnd).toHaveBeenCalledWith(node, 11);
    expect(domRange.extractContents).toHaveBeenCalledTimes(1);
    expect(domRange.insertNode).toHaveBeenCalledWith(mark);
    expect(mark.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('2. locates and highlights a range spanning multiple DOM text nodes', () => {
    // <p>Our platform <strong>leverages cutting-edge AI</strong> to provide seamless solutions.</p>
    const textBefore = textNode('Our platform ');
    const strongText = textNode('leverages cutting-edge AI');
    const strongEl = element([strongText]);
    const textAfter = textNode(' to provide seamless solutions.');
    const p = element([textBefore, strongEl, textAfter]);
    const fullText = textBefore.nodeValue + strongText.nodeValue + textAfter.nodeValue;

    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection(fullText, {
        startContainer: textBefore, startOffset: 0,
        endContainer: textAfter, endOffset: textAfter.nodeValue.length,
        commonAncestorContainer: p,
      }),
    };
    const domRange = createFakeDomRange();
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => domRange, createElement: () => mark };

    // A quote that itself starts inside <strong> and ends inside the trailing text node.
    const quote = 'cutting-edge AI to provide';
    const start = fullText.indexOf(quote);
    const end = start + quote.length;
    const startOffsetInStrong = strongText.nodeValue.indexOf('cutting-edge AI');
    const charsConsumedInStrong = strongText.nodeValue.length - startOffsetInStrong;
    const endOffsetInAfter = quote.length - charsConsumedInStrong;

    const result = locateAndHighlightInPage({ start, end, exactText: quote });

    expect(result).toEqual({ ok: true });
    expect(domRange.setStart).toHaveBeenCalledWith(strongText, startOffsetInStrong);
    expect(domRange.setEnd).toHaveBeenCalledWith(textAfter, endOffsetInAfter);
  });

  it('3. locates a range at the very beginning of the selection', () => {
    const textBefore = textNode('Our platform ');
    const textAfter = textNode('is fine.');
    const p = element([textBefore, textAfter]);
    const fullText = textBefore.nodeValue + textAfter.nodeValue;

    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection(fullText, {
        startContainer: textBefore, startOffset: 0,
        endContainer: textAfter, endOffset: textAfter.nodeValue.length,
        commonAncestorContainer: p,
      }),
    };
    const domRange = createFakeDomRange();
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => domRange, createElement: () => mark };

    const quote = 'Our platform';
    const result = locateAndHighlightInPage({ start: 0, end: quote.length, exactText: quote });

    expect(result).toEqual({ ok: true });
    expect(domRange.setStart).toHaveBeenCalledWith(textBefore, 0);
  });

  it('4. locates a range at the very end of the selection', () => {
    const textBefore = textNode('Our platform ');
    const textAfter = textNode('is fine');
    const p = element([textBefore, textAfter]);
    const fullText = textBefore.nodeValue + textAfter.nodeValue;

    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection(fullText, {
        startContainer: textBefore, startOffset: 0,
        endContainer: textAfter, endOffset: textAfter.nodeValue.length,
        commonAncestorContainer: p,
      }),
    };
    const domRange = createFakeDomRange();
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => domRange, createElement: () => mark };

    const result = locateAndHighlightInPage({ start: fullText.length - 2, end: fullText.length, exactText: 'ne' });

    expect(result).toEqual({ ok: true });
    expect(domRange.setEnd).toHaveBeenCalledWith(textAfter, textAfter.nodeValue.length);
  });

  it('5. refuses an invalid or out-of-bounds range without touching the page', () => {
    const node = textNode('Hello world');
    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection('Hello world', {
        startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
      }),
    };
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => mark };

    for (const bad of [{ start: -1, end: 5, exactText: 'Hello' }, { start: 0, end: 999, exactText: 'x' }, { start: 6, end: 3, exactText: 'x' }]) {
      expect(locateAndHighlightInPage(bad)).toEqual({ ok: false, reason: 'OUT_OF_BOUNDS' });
    }
    expect(mark.scrollIntoView).not.toHaveBeenCalled();
  });

  it('6. fails closed when the page selection no longer matches what was reviewed', () => {
    const node = textNode('Hello world');
    (globalThis as Record<string, unknown>).window = {
      // The live selection's own text no longer agrees with what its text nodes concatenate to —
      // standing in for "the DOM changed since the review was submitted".
      getSelection: () => fakeSelection('Something else entirely', {
        startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
      }),
    };
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => mark };

    const result = locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' });

    expect(result).toEqual({ ok: false, reason: 'TEXT_CHANGED' });
    expect(mark.scrollIntoView).not.toHaveBeenCalled();
  });

  it('7. replaces an existing highlight with the new one instead of stacking them', () => {
    const fakeWindow: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>).window = fakeWindow;

    const node1 = textNode('Hello world');
    fakeWindow.getSelection = () => fakeSelection('Hello world', {
      startContainer: node1, startOffset: 0, endContainer: node1, endOffset: 11, commonAncestorContainer: node1,
    });
    const mark1 = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => mark1 };
    expect(locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' })).toEqual({ ok: true });
    expect(mark1.replaceWith).not.toHaveBeenCalled();

    const node2 = textNode('Second selection');
    fakeWindow.getSelection = () => fakeSelection('Second selection', {
      startContainer: node2, startOffset: 0, endContainer: node2, endOffset: 16, commonAncestorContainer: node2,
    });
    const mark2 = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => mark2 };
    expect(locateAndHighlightInPage({ start: 0, end: 6, exactText: 'Second' })).toEqual({ ok: true });

    // The first highlight's cleanup ran (removing it) before the second one was ever created.
    expect(mark1.replaceWith).toHaveBeenCalledTimes(1);
  });

  it('8. exposes a cleanup that unwraps the highlight without altering its text', () => {
    const fakeWindow: Record<string, unknown> = {};
    const node = textNode('Hello world');
    fakeWindow.getSelection = () => fakeSelection('Hello world', {
      startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
    });
    (globalThis as Record<string, unknown>).window = fakeWindow;
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => mark };

    expect(locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' })).toEqual({ ok: true });
    const cleanup = fakeWindow[CLEANUP_KEY];
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();
    expect(mark.replaceWith).toHaveBeenCalledTimes(1);
  });

  it('9. never highlights an approximate match when the exact quote has drifted', () => {
    const node = textNode('Hello world');
    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection('Hello world', {
        startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
      }),
    };
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => mark };

    // The range is in-bounds and the selection is otherwise unchanged, but the finding's quoted
    // text is no longer what actually sits at that range — this must never fall back to
    // highlighting whatever is closest.
    const result = locateAndHighlightInPage({ start: 6, end: 11, exactText: 'World' });

    expect(result).toEqual({ ok: false, reason: 'TEXT_CHANGED' });
    expect(mark.scrollIntoView).not.toHaveBeenCalled();
  });

  it('resolves a selection whose Range boundary is an element+child-index, not a text node directly', () => {
    // Selecting an entire element with Range.selectNodeContents reports startContainer/
    // endContainer as that *element*, with offsets counting child nodes, not characters — a real
    // browser case this must handle, not just the text-node-boundary shape used above.
    const textBefore = textNode('Our platform ');
    const strongText = textNode('leverages cutting-edge AI');
    const strongEl = element([strongText]);
    const textAfter = textNode(' to provide seamless solutions.');
    const p = element([textBefore, strongEl, textAfter]);
    const fullText = textBefore.nodeValue + strongText.nodeValue + textAfter.nodeValue;

    (globalThis as Record<string, unknown>).window = {
      getSelection: () => fakeSelection(fullText, {
        startContainer: p, startOffset: 0, endContainer: p, endOffset: p.childNodes.length, commonAncestorContainer: p,
      }),
    };
    const domRange = createFakeDomRange();
    const mark = createFakeMarkElement();
    (globalThis as Record<string, unknown>).document = { createRange: () => domRange, createElement: () => mark };

    const quote = 'cutting-edge AI';
    const start = fullText.indexOf(quote);
    const result = locateAndHighlightInPage({ start, end: start + quote.length, exactText: quote });

    expect(result).toEqual({ ok: true });
    expect(domRange.setStart).toHaveBeenCalledWith(strongText, strongText.nodeValue.indexOf(quote));
  });

  it('reports no selection rather than guessing when the page selection has disappeared', () => {
    (globalThis as Record<string, unknown>).window = { getSelection: () => fakeSelection('', null) };
    (globalThis as Record<string, unknown>).document = { createRange: () => createFakeDomRange(), createElement: () => createFakeMarkElement() };

    expect(locateAndHighlightInPage({ start: 0, end: 1, exactText: 'x' })).toEqual({ ok: false, reason: 'NO_SELECTION' });
  });
});

describe('highlightArgsFor', () => {
  it('11. maps a clicked finding to exactly the {start, end, exactText} triple used for highlighting', () => {
    const finding: BrowserFinding = {
      category: 'clarity', severity: 'minor', exactText: 'seamless solutions',
      range: { start: 5, end: 24 }, explanation: 'Vague phrasing.', confidence: 0.8,
    };
    expect(highlightArgsFor(finding)).toEqual({ start: 5, end: 24, exactText: 'seamless solutions' });
  });
});
