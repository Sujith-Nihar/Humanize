import type { BrowserText } from './types.js';

export const BROWSER_TEXT_SCHEMA_VERSION = 'humanize-browsertext-v1' as const;

export type SourceType = 'webpage_selection' | 'editor_selection' | 'devtools_selection';
/** Exactly the allow-list docs/architecture/browser-text.md §7 defines — nothing else. */
export interface OriginMetadata { hostname?: string; documentType?: 'html' | 'markdown' | 'plaintext'; browserFamily?: string; }

export interface BuildBrowserTextInput {
  selectedText: string;
  requestId: string;
  sourceType?: SourceType;
  originMetadata?: OriginMetadata;
}
export type BuildBrowserTextResult =
  | { ok: true; browserText: BrowserText }
  | { ok: false; reason: 'EMPTY_SELECTION' };

/**
 * Builds the BrowserText request from an explicitly captured selection. The character range is
 * always `{0, selectedText.length}` — relative to the submitted text itself, never a page/DOM
 * coordinate, exactly as the BrowserText contract defines it (docs/architecture/browser-text.md
 * §6). This function never reads a page, a DOM node, or anything beyond the string it is given.
 */
export function buildBrowserText(input: BuildBrowserTextInput): BuildBrowserTextResult {
  const text = input.selectedText;
  if (!text.trim()) return { ok: false, reason: 'EMPTY_SELECTION' };
  const browserText: BrowserText = {
    schemaVersion: BROWSER_TEXT_SCHEMA_VERSION,
    requestId: input.requestId,
    text,
    characterRange: { start: 0, end: text.length },
    sourceType: input.sourceType ?? 'webpage_selection',
    language: 'en',
    ...(input.originMetadata ? { originMetadata: input.originMetadata } : {}),
  };
  return { ok: true, browserText };
}

/**
 * The only origin metadata this extension ever constructs: a bare hostname, discarding path,
 * query string, fragment, credentials and port. Never the full URL, and never a page title —
 * this function is never given one to begin with.
 */
export function originMetadataFromUrl(url: string | undefined): OriginMetadata | undefined {
  if (!url) return undefined;
  try {
    const hostname = new URL(url).hostname;
    return hostname ? { hostname } : undefined;
  } catch {
    return undefined;
  }
}
