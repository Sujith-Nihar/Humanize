import { describe, expect, it } from 'vitest';
import { buildBrowserText, originMetadataFromUrl } from './src/selection.js';

const requestId = '11111111-1111-4111-8111-111111111111';

describe('buildBrowserText', () => {
  it('1/3. turns selected text into a BrowserText value with the correct schema version', () => {
    const result = buildBrowserText({ selectedText: 'Unlock unprecedented potential.', requestId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.browserText.schemaVersion).toBe('humanize-browsertext-v1');
    expect(result.browserText.requestId).toBe(requestId);
    expect(result.browserText.text).toBe('Unlock unprecedented potential.');
    expect(result.browserText.sourceType).toBe('webpage_selection');
  });

  it('2. sets the character range to 0..selectedText.length, never a page coordinate', () => {
    const text = 'Our platform is great, but the phrasing is generic.';
    const result = buildBrowserText({ selectedText: text, requestId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.browserText.characterRange).toEqual({ start: 0, end: text.length });
  });

  it('4/5/6. sends only the allowed origin metadata: no full URL, no query/path/fragment, no page title', () => {
    const result = buildBrowserText({
      selectedText: 'Some selected text.', requestId,
      originMetadata: { hostname: 'docs.example.com' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = result.browserText.originMetadata;
    expect(metadata).toEqual({ hostname: 'docs.example.com' });
    expect(Object.keys(metadata ?? {})).toEqual(['hostname']);
    const serialized = JSON.stringify(result.browserText);
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('title');
  });

  it('7. rejects an empty (or whitespace-only) selection', () => {
    for (const empty of ['', '   ', '\n\t']) {
      const result = buildBrowserText({ selectedText: empty, requestId });
      expect(result).toEqual({ ok: false, reason: 'EMPTY_SELECTION' });
    }
  });
});

describe('originMetadataFromUrl', () => {
  it('4/5/6. keeps only the hostname, discarding path, query, fragment and any page title', () => {
    const metadata = originMetadataFromUrl('https://docs.example.com/secret/path?token=abc&title=Confidential#section');
    expect(metadata).toEqual({ hostname: 'docs.example.com' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain('token');
    expect(JSON.stringify(metadata)).not.toContain('Confidential');
  });

  it('returns undefined for an unparseable or absent URL, rather than guessing', () => {
    expect(originMetadataFromUrl(undefined)).toBeUndefined();
    expect(originMetadataFromUrl('not a url')).toBeUndefined();
  });
});
