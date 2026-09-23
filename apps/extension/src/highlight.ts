// Client-side, on-demand page highlighting for a clicked finding. Nothing here is a persistent
// content script: every function in this file only ever runs because chrome.scripting.executeScript
// injected it into the active tab in direct response to the user clicking a finding card, exactly
// the same on-demand model selection.ts's selection reader already uses (see popup.ts). No new
// permission is needed — activeTab + scripting already cover this.
import type { BrowserFinding } from './types.js';

export type HighlightFailureReason =
  | 'NO_SELECTION'   // the page has no active selection any more (or it collapsed to nothing)
  | 'TEXT_CHANGED'   // the live selection's text no longer matches what was actually reviewed
  | 'OUT_OF_BOUNDS';  // the finding's range doesn't fit inside the (still-matching) selection text

export type HighlightPageResult = { ok: true } | { ok: false; reason: HighlightFailureReason };

export interface LocateAndHighlightArgs {
  start: number;
  end: number;
  exactText: string;
}

/** The exact triple `locateAndHighlightInPage` needs, taken straight from a finding — never a
 * re-derived or approximated range. */
export function highlightArgsFor(finding: Pick<BrowserFinding, 'range' | 'exactText'>): LocateAndHighlightArgs {
  return { start: finding.range.start, end: finding.range.end, exactText: finding.exactText };
}

/**
 * Passed directly as `chrome.scripting.executeScript`'s `func`, which serializes this function
 * with `Function.prototype.toString()` and re-runs the source, standalone, inside the page. That
 * means it must not reference anything outside its own body — no imports, no module-level
 * bindings, only ambient page globals (`window`, `document`) and its own nested helpers. It is
 * still unit-tested directly (see highlight.test.ts), by stubbing `window`/`document` before
 * calling it — the exact same function runs in both places.
 *
 * The finding's range is relative to the BrowserText the extension submitted, i.e. to
 * `window.getSelection()!.toString()` at review time — never a page-wide coordinate. This
 * function re-reads the *current* selection, re-derives that same flattened string, and refuses
 * to guess if either the selection or the exact quoted text no longer matches what was reviewed:
 * a stale or moved selection fails closed (a safe "couldn't locate"), never an approximate
 * highlight.
 */
export function locateAndHighlightInPage(args: LocateAndHighlightArgs): HighlightPageResult {
  type Span = { node: unknown; text: string };

  function collectTextSpans(root: unknown): Span[] {
    const spans: Span[] = [];
    (function walk(node: unknown): void {
      const n = node as { nodeType: number; nodeValue?: string | null; childNodes?: ArrayLike<unknown> };
      if (n.nodeType === 3) {
        spans.push({ node, text: n.nodeValue ?? '' });
        return;
      }
      const children = n.childNodes;
      if (!children) return;
      for (let i = 0; i < children.length; i++) walk(children[i]);
    })(root);
    return spans;
  }

  type NodeLike = { nodeType: number; nodeValue?: string | null; childNodes?: ArrayLike<unknown> };

  function firstTextNode(node: unknown): NodeLike | null {
    const n = node as NodeLike;
    if (n.nodeType === 3) return n;
    const children = n.childNodes;
    if (!children) return null;
    for (let i = 0; i < children.length; i++) {
      const found = firstTextNode(children[i]);
      if (found) return found;
    }
    return null;
  }
  function lastTextNode(node: unknown): NodeLike | null {
    const n = node as NodeLike;
    if (n.nodeType === 3) return n;
    const children = n.childNodes;
    if (!children) return null;
    for (let i = children.length - 1; i >= 0; i--) {
      const found = lastTextNode(children[i]);
      if (found) return found;
    }
    return null;
  }
  /**
   * A Range boundary is a (container, offset) pair; when container is an *element*, offset counts
   * child nodes, not characters (e.g. `Range.selectNodeContents(p)` reports `{container: p,
   * offset: 0}` and `{container: p, offset: p.childNodes.length}` — never a text node directly).
   * This resolves any such boundary down to the (text node, character offset) pair it actually
   * denotes, so the walk below can always compare against real text-node identities.
   */
  function normalizeBoundary(container: unknown, offset: number): { node: unknown; offset: number } | null {
    const c = container as NodeLike;
    if (c.nodeType === 3) return { node: container, offset };
    const children = c.childNodes;
    if (!children) return null;
    if (offset < children.length) {
      const node = firstTextNode(children[offset]);
      if (node) return { node, offset: 0 };
    }
    for (let i = Math.min(offset, children.length) - 1; i >= 0; i--) {
      const node = lastTextNode(children[i]);
      if (node) return { node, offset: node.nodeValue?.length ?? 0 };
    }
    return null;
  }

  function collectRangeTextSpans(range: {
    startContainer: unknown; startOffset: number;
    endContainer: unknown; endOffset: number;
    commonAncestorContainer: unknown;
  }): Span[] {
    const start = normalizeBoundary(range.startContainer, range.startOffset);
    const end = normalizeBoundary(range.endContainer, range.endOffset);
    if (!start || !end) return [];
    const all = collectTextSpans(range.commonAncestorContainer);
    const result: Span[] = [];
    let inRange = false;
    for (const span of all) {
      const atStart = span.node === start.node;
      const atEnd = span.node === end.node;
      if (!inRange) {
        if (atStart) inRange = true;
        else continue;
      }
      let text = span.text;
      if (atStart && atEnd) text = text.slice(start.offset, end.offset);
      else if (atStart) text = text.slice(start.offset);
      else if (atEnd) text = text.slice(0, end.offset);
      result.push({ node: span.node, text });
      if (atEnd) break;
    }
    return result;
  }

  function locatePositions(spans: Span[], start: number, end: number):
    { startNode: unknown; startOffset: number; endNode: unknown; endOffset: number } | null {
    let cursor = 0;
    let startNode: unknown, startOffset = 0, endNode: unknown, endOffset = 0;
    let foundStart = false, foundEnd = false;
    for (const span of spans) {
      const len = span.text.length;
      if (!foundStart && start >= cursor && start <= cursor + len) {
        startNode = span.node; startOffset = start - cursor; foundStart = true;
      }
      if (!foundEnd && end >= cursor && end <= cursor + len) {
        endNode = span.node; endOffset = end - cursor; foundEnd = true;
      }
      cursor += len;
      if (foundStart && foundEnd) break;
    }
    if (!foundStart || !foundEnd) return null;
    return { startNode, startOffset, endNode, endOffset };
  }

  const CLEANUP_KEY = '__humanizeHighlightCleanup__';
  const win = window as unknown as Record<string, unknown>;
  const previousCleanup = win[CLEANUP_KEY];
  if (typeof previousCleanup === 'function') {
    try { (previousCleanup as () => void)(); } catch { /* best-effort removal of a stale highlight */ }
  }
  win[CLEANUP_KEY] = undefined;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return { ok: false, reason: 'NO_SELECTION' };
  const liveRange = selection.getRangeAt(0);
  const selectionText = selection.toString();

  const spans = collectRangeTextSpans(liveRange as unknown as Parameters<typeof collectRangeTextSpans>[0]);
  const concatenated = spans.map(span => span.text).join('');
  if (concatenated !== selectionText) return { ok: false, reason: 'TEXT_CHANGED' };

  const { start, end } = args;
  if (start < 0 || end > selectionText.length || start >= end) return { ok: false, reason: 'OUT_OF_BOUNDS' };
  if (selectionText.slice(start, end) !== args.exactText) return { ok: false, reason: 'TEXT_CHANGED' };

  const located = locatePositions(spans, start, end);
  if (!located) return { ok: false, reason: 'OUT_OF_BOUNDS' };

  const highlightRange = document.createRange();
  highlightRange.setStart(located.startNode as Node, located.startOffset);
  highlightRange.setEnd(located.endNode as Node, located.endOffset);

  const mark = document.createElement('mark');
  mark.className = 'humanize-highlight';
  mark.style.backgroundColor = '#ffe066';
  mark.style.color = 'inherit';
  // extractContents works whether the range sits inside one text node or crosses several sibling
  // elements (unlike the alternative single-parent-only wrapping API); it only ever moves the
  // already-selected text nodes into the wrapper, never edits their content.
  const fragment = highlightRange.extractContents();
  mark.appendChild(fragment);
  highlightRange.insertNode(mark);
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });

  win[CLEANUP_KEY] = () => { mark.replaceWith(...Array.from(mark.childNodes)); };

  return { ok: true };
}
