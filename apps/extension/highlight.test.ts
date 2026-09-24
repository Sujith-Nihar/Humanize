import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearHighlightInPage, highlightArgsFor, locateAndHighlightInPage } from './src/highlight.js';
import type { BrowserFinding } from './src/types.js';

// Plain-object stand-ins for DOM nodes: real Text/Element nodes satisfy this same shape
// (nodeType 3 for text, childNodes for elements), so the exact traversal logic under test here
// runs identically against a real page. No jsdom or other DOM dependency is added for this.
function textNode(value: string, parentElement: unknown = fakeElement()) {
  return { nodeType: 3, nodeValue: value, parentElement };
}
function element(children: unknown[]) {
  return { nodeType: 1, childNodes: children };
}
function fakeElement() {
  return { scrollIntoView: vi.fn() };
}

/** A fake `document.createRange()` result: records what the implementation does to it. */
function createFakeDomRange() {
  return { setStart: vi.fn(), setEnd: vi.fn() };
}

/** A fake `Highlight` constructor and `CSS.highlights` registry — the CSS Custom Highlight API
 * paints purely via a stylesheet rule, never touching the DOM tree (see highlight.ts's comment
 * on why this replaced an earlier node-wrapping approach). */
function createFakeHighlightApi() {
  const registry = new Map<string, unknown>();
  const HighlightCtor = vi.fn(function (this: { range: unknown }, range: unknown) { this.range = range; }) as unknown as new (range: unknown) => { range: unknown };
  return { registry, HighlightCtor };
}

function createFakeDocument(range: ReturnType<typeof createFakeDomRange>) {
  return {
    createRange: () => range,
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: vi.fn() },
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

function setupEnv(selectionText: string, range: FakeLiveRange | null, extraWindow: Record<string, unknown> = {}) {
  const domRange = createFakeDomRange();
  const { registry, HighlightCtor } = createFakeHighlightApi();
  const win: Record<string, unknown> = {
    getSelection: () => fakeSelection(selectionText, range),
    CSS: { highlights: registry },
    Highlight: HighlightCtor,
    ...extraWindow,
  };
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = createFakeDocument(domRange);
  return { domRange, registry, HighlightCtor, win };
}

const CLEANUP_KEY = '__humanizeHighlightCleanup__';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe('locateAndHighlightInPage', () => {
  it('1. locates and highlights an exact range inside a single text node', () => {
    const node = textNode('Hello world');
    const { domRange, registry } = setupEnv('Hello world', {
      startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
    });

    const result = locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' });

    expect(result).toEqual({ ok: true });
    expect(domRange.setStart).toHaveBeenCalledWith(node, 6);
    expect(domRange.setEnd).toHaveBeenCalledWith(node, 11);
    expect(registry.has('humanize-highlight')).toBe(true);
    expect((node.parentElement as { scrollIntoView: ReturnType<typeof vi.fn> }).scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('2. locates and highlights a range spanning multiple DOM text nodes', () => {
    // <p>Our platform <strong>leverages cutting-edge AI</strong> to provide seamless solutions.</p>
    const textBefore = textNode('Our platform ');
    const strongText = textNode('leverages cutting-edge AI');
    const strongEl = element([strongText]);
    const textAfter = textNode(' to provide seamless solutions.');
    const p = element([textBefore, strongEl, textAfter]);
    const fullText = textBefore.nodeValue + strongText.nodeValue + textAfter.nodeValue;

    const { domRange } = setupEnv(fullText, {
      startContainer: textBefore, startOffset: 0,
      endContainer: textAfter, endOffset: textAfter.nodeValue.length,
      commonAncestorContainer: p,
    });

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

    const { domRange } = setupEnv(fullText, {
      startContainer: textBefore, startOffset: 0,
      endContainer: textAfter, endOffset: textAfter.nodeValue.length,
      commonAncestorContainer: p,
    });

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

    const { domRange } = setupEnv(fullText, {
      startContainer: textBefore, startOffset: 0,
      endContainer: textAfter, endOffset: textAfter.nodeValue.length,
      commonAncestorContainer: p,
    });

    const result = locateAndHighlightInPage({ start: fullText.length - 2, end: fullText.length, exactText: 'ne' });

    expect(result).toEqual({ ok: true });
    expect(domRange.setEnd).toHaveBeenCalledWith(textAfter, textAfter.nodeValue.length);
  });

  it('5. refuses an invalid or out-of-bounds range without touching the page', () => {
    const node = textNode('Hello world');
    const { registry } = setupEnv('Hello world', {
      startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
    });

    for (const bad of [{ start: -1, end: 5, exactText: 'Hello' }, { start: 0, end: 999, exactText: 'x' }, { start: 6, end: 3, exactText: 'x' }]) {
      expect(locateAndHighlightInPage(bad)).toEqual({ ok: false, reason: 'OUT_OF_BOUNDS' });
    }
    expect(registry.size).toBe(0);
  });

  it('6. fails closed when the page selection no longer matches what was reviewed', () => {
    const node = textNode('Hello world');
    // The live selection's own text no longer agrees with what its text nodes concatenate to —
    // standing in for "the DOM changed since the review was submitted".
    const { registry } = setupEnv('Something else entirely', {
      startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
    });

    const result = locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' });

    expect(result).toEqual({ ok: false, reason: 'TEXT_CHANGED' });
    expect(registry.size).toBe(0);
  });

  it('7. replaces an existing highlight with the new one instead of stacking them', () => {
    const node1 = textNode('Hello world');
    const { registry } = setupEnv('Hello world', {
      startContainer: node1, startOffset: 0, endContainer: node1, endOffset: 11, commonAncestorContainer: node1,
    });
    expect(locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' })).toEqual({ ok: true });
    expect(registry.has('humanize-highlight')).toBe(true);
    const firstHighlight = registry.get('humanize-highlight');

    // Same window (so the stashed cleanup persists across calls), new selection/range/document.
    const node2 = textNode('Second selection');
    const win = (globalThis as Record<string, unknown>).window as Record<string, unknown>;
    win.getSelection = () => fakeSelection('Second selection', {
      startContainer: node2, startOffset: 0, endContainer: node2, endOffset: 16, commonAncestorContainer: node2,
    });
    (globalThis as Record<string, unknown>).document = createFakeDocument(createFakeDomRange());

    expect(locateAndHighlightInPage({ start: 0, end: 6, exactText: 'Second' })).toEqual({ ok: true });

    // Exactly one highlight is ever registered under this name — the second call replaced it.
    expect(registry.size).toBe(1);
    expect(registry.get('humanize-highlight')).not.toBe(firstHighlight);
  });

  it('8. exposes a cleanup that removes the highlight registration, never page text', () => {
    const node = textNode('Hello world');
    const { registry, win } = setupEnv('Hello world', {
      startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
    });

    expect(locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' })).toEqual({ ok: true });
    expect(registry.has('humanize-highlight')).toBe(true);

    const cleanup = win[CLEANUP_KEY];
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();
    expect(registry.has('humanize-highlight')).toBe(false);
  });

  it('9. never highlights an approximate match when the exact quote has drifted', () => {
    const node = textNode('Hello world');
    const { registry } = setupEnv('Hello world', {
      startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node,
    });

    // The range is in-bounds and the selection is otherwise unchanged, but the finding's quoted
    // text is no longer what actually sits at that range — this must never fall back to
    // highlighting whatever is closest.
    const result = locateAndHighlightInPage({ start: 6, end: 11, exactText: 'World' });

    expect(result).toEqual({ ok: false, reason: 'TEXT_CHANGED' });
    expect(registry.size).toBe(0);
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

    const { domRange } = setupEnv(fullText, {
      startContainer: p, startOffset: 0, endContainer: p, endOffset: p.childNodes.length, commonAncestorContainer: p,
    });

    const quote = 'cutting-edge AI';
    const start = fullText.indexOf(quote);
    const result = locateAndHighlightInPage({ start, end: start + quote.length, exactText: quote });

    expect(result).toEqual({ ok: true });
    expect(domRange.setStart).toHaveBeenCalledWith(strongText, strongText.nodeValue.indexOf(quote));
  });

  it('respects prefers-reduced-motion by scrolling without smooth animation', () => {
    const node = textNode('Hello world');
    setupEnv('Hello world',
      { startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node },
      { matchMedia: (query: string) => ({ matches: query.includes('reduce') }) },
    );

    expect(locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' })).toEqual({ ok: true });

    const parent = node.parentElement as { scrollIntoView: ReturnType<typeof vi.fn> };
    expect(parent.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('reports unsupported, never guessing an alternative, when the page has no Highlight API', () => {
    const node = textNode('Hello world');
    setupEnv('Hello world',
      { startContainer: node, startOffset: 0, endContainer: node, endOffset: 11, commonAncestorContainer: node },
      { CSS: {}, Highlight: undefined },
    );

    expect(locateAndHighlightInPage({ start: 6, end: 11, exactText: 'world' })).toEqual({ ok: false, reason: 'UNSUPPORTED' });
  });

  it('reports no selection rather than guessing when the page selection has disappeared', () => {
    setupEnv('', null);
    expect(locateAndHighlightInPage({ start: 0, end: 1, exactText: 'x' })).toEqual({ ok: false, reason: 'NO_SELECTION' });
  });
});

describe('clearHighlightInPage', () => {
  it('invokes and clears a stashed cleanup, so a stale highlight never lingers into a new review', () => {
    const fakeWindow: Record<string, unknown> = {};
    const cleanup = vi.fn();
    fakeWindow[CLEANUP_KEY] = cleanup;
    (globalThis as Record<string, unknown>).window = fakeWindow;

    expect(clearHighlightInPage()).toEqual({ ok: true });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fakeWindow[CLEANUP_KEY]).toBeUndefined();
  });

  it('is a harmless no-op when nothing was ever highlighted', () => {
    (globalThis as Record<string, unknown>).window = {};
    expect(clearHighlightInPage()).toEqual({ ok: true });
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
