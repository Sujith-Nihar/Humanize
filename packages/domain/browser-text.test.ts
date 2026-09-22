import { describe, it, expect } from 'vitest';
import { BROWSER_TEXT_SCHEMA_VERSION, BrowserTextLimits, BrowserTextSchema } from './src/index.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const text = 'Unlock unprecedented potential today.';
const valid = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: BROWSER_TEXT_SCHEMA_VERSION,
  requestId,
  text,
  characterRange: { start: 0, end: text.length },
  sourceType: 'webpage_selection',
  ...overrides,
});

describe('BrowserText', () => {
  it('1. accepts a valid BrowserText value, applying the default language', () => {
    const result = BrowserTextSchema.safeParse(valid());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe('en');
  });

  it('2. rejects a value missing any required field', () => {
    const { schemaVersion, requestId: id, text: value, characterRange, sourceType } = valid();
    expect(BrowserTextSchema.safeParse({ requestId: id, text: value, characterRange, sourceType }).success).toBe(false);
    expect(BrowserTextSchema.safeParse({ schemaVersion, text: value, characterRange, sourceType }).success).toBe(false);
    expect(BrowserTextSchema.safeParse({ schemaVersion, requestId: id, characterRange, sourceType }).success).toBe(false);
    expect(BrowserTextSchema.safeParse({ schemaVersion, requestId: id, text: value, sourceType }).success).toBe(false);
    expect(BrowserTextSchema.safeParse({ schemaVersion, requestId: id, text: value, characterRange }).success).toBe(false);
  });

  it('3. rejects an unsupported schema version', () => {
    expect(BrowserTextSchema.safeParse(valid({ schemaVersion: 'humanize-browsertext-v2' })).success).toBe(false);
  });

  it('4. rejects empty text', () => {
    expect(BrowserTextSchema.safeParse(valid({ text: '', characterRange: { start: 0, end: 0 } })).success).toBe(false);
  });

  it('5. rejects text exceeding the configured limit', () => {
    const long = 'a'.repeat(BrowserTextLimits.textChars + 1);
    expect(BrowserTextSchema.safeParse(valid({ text: long, characterRange: { start: 0, end: long.length } })).success).toBe(false);
  });

  it('6. accepts a range spanning the whole submitted text', () => {
    expect(BrowserTextSchema.safeParse(valid({ characterRange: { start: 0, end: text.length } })).success).toBe(true);
  });

  it('7. accepts a sub-range within the submitted text', () => {
    expect(BrowserTextSchema.safeParse(valid({ characterRange: { start: 7, end: 20 } })).success).toBe(true);
  });

  it('8. rejects a negative range', () => {
    expect(BrowserTextSchema.safeParse(valid({ characterRange: { start: -1, end: 5 } })).success).toBe(false);
  });

  it('9. rejects a range extending beyond the submitted text', () => {
    expect(BrowserTextSchema.safeParse(valid({ characterRange: { start: 0, end: text.length + 1 } })).success).toBe(false);
  });

  it('10. rejects a range whose start is greater than its end', () => {
    expect(BrowserTextSchema.safeParse(valid({ characterRange: { start: 10, end: 5 } })).success).toBe(false);
  });

  it('11. rejects a range that splits a surrogate pair', () => {
    const emoji = 'Hi \u{1F600} there'; // a single astral character, two UTF-16 code units
    const insideThePair = emoji.indexOf('\u{1F600}') + 1;
    expect(BrowserTextSchema.safeParse(valid({ text: emoji, characterRange: { start: insideThePair, end: emoji.length } })).success).toBe(false);
    // The same boundary is fine on either side of the pair.
    expect(BrowserTextSchema.safeParse(valid({ text: emoji, characterRange: { start: 0, end: insideThePair - 1 } })).success).toBe(true);
  });

  it('12. rejects an unrecognized sourceType', () => {
    expect(BrowserTextSchema.safeParse(valid({ sourceType: 'crawled_page' })).success).toBe(false);
  });

  it('13. rejects disallowed origin metadata', () => {
    for (const originMetadata of [
      { pageUrl: 'https://example.com/secret?token=1' },
      { pageTitle: 'Confidential document' },
      { cookies: 'session=abc' },
      { selector: '#main > div.hero' },
      { hostname: 'docs.example.com', userAgent: 'Mozilla/5.0 (fingerprinting-grade string)' },
    ]) {
      expect(BrowserTextSchema.safeParse(valid({ originMetadata })).success).toBe(false);
    }
  });

  it('14. accepts minimal valid origin metadata, including none at all', () => {
    expect(BrowserTextSchema.safeParse(valid()).success).toBe(true);
    expect(BrowserTextSchema.safeParse(valid({ originMetadata: {} })).success).toBe(true);
    expect(BrowserTextSchema.safeParse(valid({ originMetadata: { hostname: 'docs.example.com' } })).success).toBe(true);
    expect(BrowserTextSchema.safeParse(valid({ originMetadata: { hostname: 'docs.example.com', documentType: 'markdown', browserFamily: 'chrome/128' } })).success).toBe(true);
  });
});
