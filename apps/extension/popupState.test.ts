import { describe, expect, it } from 'vitest';
import { MESSAGES, actionButtonFor, canStartReview, detailFor, messageFor, viewForOutcome } from './src/popupState.js';
import type { PopupView } from './src/popupState.js';
import type { ReviewOutcome } from './src/controller.js';

const ALL_VIEWS: PopupView[] = [
  { kind: 'empty' },
  { kind: 'ready', preview: 'Some selected text' },
  { kind: 'loading' },
  { kind: 'findings', findings: [] },
  { kind: 'no-findings' },
  { kind: 'auth-required' },
  { kind: 'rate-limited' },
  { kind: 'provider-unavailable' },
  { kind: 'invalid-request' },
];

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

describe('detailFor', () => {
  it('adds a caveat under "no findings" so it never reads as a guarantee', () => {
    const detail = detailFor({ kind: 'no-findings' });
    expect(detail).toBe(MESSAGES.noFindingsDetail);
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.toLowerCase()).not.toContain('guaranteed');
  });

  it('has nothing to add for every other view', () => {
    for (const view of ALL_VIEWS) {
      if (view.kind === 'no-findings') continue;
      expect(detailFor(view)).toBe('');
    }
  });
});

describe('actionButtonFor', () => {
  it('shows the Review button, disabled, when there is no selection to review', () => {
    expect(actionButtonFor({ kind: 'empty' })).toEqual({ kind: 'review', disabled: true, label: MESSAGES.reviewButton });
  });

  it('enables the Review button once a selection is available', () => {
    expect(actionButtonFor({ kind: 'ready', preview: 'x' })).toEqual({ kind: 'review', disabled: false, label: MESSAGES.reviewButton });
  });

  it('keeps the Review button visible but disabled while a request is loading, preventing duplicate submissions', () => {
    expect(actionButtonFor({ kind: 'loading' })).toEqual({ kind: 'review', disabled: true, label: MESSAGES.reviewButton });
  });

  it('gives every terminal state — success or failure — a way to retry, so the popup can never get stuck', () => {
    const terminal: PopupView[] = [
      { kind: 'findings', findings: [] },
      { kind: 'no-findings' },
      { kind: 'rate-limited' },
      { kind: 'provider-unavailable' },
      { kind: 'invalid-request' },
    ];
    for (const view of terminal) {
      expect(actionButtonFor(view)).toEqual({ kind: 'retry', disabled: false, label: MESSAGES.retryButton });
    }
  });

  it('preserves the existing credential-entry affordance for auth-required, unchanged', () => {
    expect(actionButtonFor({ kind: 'auth-required' })).toEqual({ kind: 'save', disabled: false, label: 'Save' });
  });

  it('never leaves any view without an actionable button', () => {
    for (const view of ALL_VIEWS) {
      expect(actionButtonFor(view).kind).not.toBe('none');
    }
  });
});

describe('canStartReview', () => {
  it('refuses a second review while one is already in flight, even from the ready state', () => {
    expect(canStartReview({ kind: 'ready', preview: 'x' }, true)).toBe(false);
  });

  it('allows a review once a selection is ready and nothing is in flight', () => {
    expect(canStartReview({ kind: 'ready', preview: 'x' }, false)).toBe(true);
  });

  it('never allows a review to start with no selection or while already loading', () => {
    expect(canStartReview({ kind: 'empty' }, false)).toBe(false);
    expect(canStartReview({ kind: 'loading' }, false)).toBe(false);
  });
});
