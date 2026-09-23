import { describe, expect, it } from 'vitest';
import { MESSAGES, messageFor, viewForOutcome } from './src/popupState.js';
import type { ReviewOutcome } from './src/controller.js';

describe('viewForOutcome', () => {
  it('11. maps a missing credential and a 401 both to the authentication-required view', () => {
    expect(viewForOutcome({ state: 'no-credential' })).toEqual({ kind: 'auth-required' });
    expect(viewForOutcome({ state: 'error', code: 'UNAUTHENTICATED' })).toEqual({ kind: 'auth-required' });
    expect(messageFor(viewForOutcome({ state: 'error', code: 'UNAUTHENTICATED' }))).toBe(MESSAGES.authRequired);
  });

  it('12. maps a rate-limit failure to the rate-limited view', () => {
    const view = viewForOutcome({ state: 'error', code: 'RATE_LIMITED' });
    expect(view).toEqual({ kind: 'rate-limited' });
    expect(messageFor(view)).toBe(MESSAGES.rateLimited);
  });

  it('13. maps a provider failure to a safe, generic view — never a raw provider error', () => {
    const view = viewForOutcome({ state: 'error', code: 'PROVIDER_UNAVAILABLE' });
    expect(view).toEqual({ kind: 'provider-unavailable' });
    const message = messageFor(view);
    expect(message).toBe(MESSAGES.providerUnavailable);
    expect(message.toLowerCase()).not.toContain('openai');
    expect(message.toLowerCase()).not.toContain('ollama');
    expect(message.toLowerCase()).not.toContain('stack');
  });

  it('maps a malformed/invalid request to the same non-technical message as an empty selection', () => {
    const outcomes: ReviewOutcome[] = [{ state: 'empty-selection' }, { state: 'error', code: 'INVALID_REQUEST' }, { state: 'error', code: 'NETWORK_ERROR' }];
    for (const outcome of outcomes) {
      const view = viewForOutcome(outcome);
      expect(view).toEqual({ kind: 'invalid-request' });
      expect(messageFor(view)).toBe(MESSAGES.invalidRequest);
    }
  });

  it('14. renders a successful review with findings', () => {
    const finding = { category: 'ai_like_generic', severity: 'minor' as const, exactText: 'Unlock unprecedented potential', range: { start: 0, end: 30 }, explanation: 'Broad promotional wording.', confidence: 0.9 };
    const view = viewForOutcome({ state: 'success', findings: [finding] });
    expect(view).toEqual({ kind: 'findings', findings: [finding] });
  });

  it('15. renders "No issues found." when the review produced no findings, never a certainty claim', () => {
    const view = viewForOutcome({ state: 'success', findings: [] });
    expect(view).toEqual({ kind: 'no-findings' });
    expect(messageFor(view)).toBe('No issues found.');
    expect(messageFor(view).toLowerCase()).not.toContain('written by ai');
    expect(messageFor(view).toLowerCase()).not.toContain('definitely');
  });
});

describe('MESSAGES', () => {
  it('never asserts certainty about AI authorship anywhere in the fixed copy', () => {
    for (const message of Object.values(MESSAGES)) {
      expect(message.toLowerCase()).not.toContain('written by ai');
      expect(message.toLowerCase()).not.toContain('ai-generated');
      expect(message.toLowerCase()).not.toContain('definitely');
    }
  });
});
