import { describe, expect, it } from 'vitest';
import {
  MESSAGES, actionButtonFor, canGoToNextFinding, canGoToPreviousFinding, canStartReview,
  copyFor, nextFindingIndex, previousFindingIndex, resultsSummary, viewForOutcome,
} from './src/popupState.js';
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
    expect(copyFor(viewForOutcome({ state: 'error', code: 'UNAUTHENTICATED' }))?.title).toBe('Connect Humanize');
  });

  it('12. maps a rate-limit failure to the rate-limited view', () => {
    const view = viewForOutcome({ state: 'error', code: 'RATE_LIMITED' });
    expect(view).toEqual({ kind: 'rate-limited' });
    expect(copyFor(view)?.detail).toBe('Please wait a moment and try again.');
  });

  it('13. maps a provider failure to a safe, generic view — never a raw provider error', () => {
    const view = viewForOutcome({ state: 'error', code: 'PROVIDER_UNAVAILABLE' });
    expect(view).toEqual({ kind: 'provider-unavailable' });
    const copy = copyFor(view);
    expect(copy).not.toBeNull();
    const combined = `${copy!.title} ${copy!.detail}`.toLowerCase();
    expect(combined).not.toContain('openai');
    expect(combined).not.toContain('ollama');
    expect(combined).not.toContain('stack');
    expect(combined).not.toContain('provider');
  });

  it('maps a malformed/invalid request to the same non-technical view as an empty selection', () => {
    const outcomes: ReviewOutcome[] = [{ state: 'empty-selection' }, { state: 'error', code: 'INVALID_REQUEST' }, { state: 'error', code: 'NETWORK_ERROR' }];
    for (const outcome of outcomes) {
      const view = viewForOutcome(outcome);
      expect(view).toEqual({ kind: 'invalid-request' });
      expect(copyFor(view)?.title).toBe('Something went wrong');
    }
  });

  it('14. renders a successful review with findings', () => {
    const finding = { category: 'ai_like_generic', severity: 'minor' as const, exactText: 'Unlock unprecedented potential', range: { start: 0, end: 30 }, explanation: 'Broad promotional wording.', confidence: 0.9 };
    const view = viewForOutcome({ state: 'success', findings: [finding] });
    expect(view).toEqual({ kind: 'findings', findings: [finding] });
  });

  it('15. renders a positive "no findings" view, never a certainty claim', () => {
    const view = viewForOutcome({ state: 'success', findings: [] });
    expect(view).toEqual({ kind: 'no-findings' });
    const copy = copyFor(view);
    expect(copy?.title).toBe('Looks good');
    const combined = `${copy!.title} ${copy!.detail}`.toLowerCase();
    expect(combined).not.toContain('written by ai');
    expect(combined).not.toContain('definitely');
  });
});

describe('copyFor', () => {
  it('has a {title, detail} pair for every plain-status view', () => {
    for (const kind of ['empty', 'auth-required', 'rate-limited', 'provider-unavailable', 'invalid-request', 'no-findings'] as const) {
      const copy = copyFor({ kind } as PopupView);
      expect(copy).not.toBeNull();
      expect(copy!.title.length).toBeGreaterThan(0);
      expect(copy!.detail.length).toBeGreaterThan(0);
    }
  });

  it('returns null for the bespoke-layout views (ready, loading, findings)', () => {
    expect(copyFor({ kind: 'ready', preview: 'x' })).toBeNull();
    expect(copyFor({ kind: 'loading' })).toBeNull();
    expect(copyFor({ kind: 'findings', findings: [] })).toBeNull();
  });

  it('never asserts certainty about AI authorship or exposes developer language, anywhere', () => {
    const banned = ['written by ai', 'ai-generated', 'definitely', 'api error', 'provider unavailable', 'request failed', 'invalid response', 'candidate', 'schema', 'verification', 'stack trace'];
    for (const view of ALL_VIEWS) {
      const copy = copyFor(view);
      if (!copy) continue;
      const combined = `${copy.title} ${copy.detail}`.toLowerCase();
      for (const phrase of banned) expect(combined, `${view.kind}: "${combined}" must not contain "${phrase}"`).not.toContain(phrase);
    }
    for (const message of Object.values(MESSAGES)) {
      const lower = message.toLowerCase();
      for (const phrase of banned) expect(lower, `"${message}" must not contain "${phrase}"`).not.toContain(phrase);
    }
  });
});

describe('resultsSummary', () => {
  it('uses singular phrasing for exactly one finding', () => {
    expect(resultsSummary(1)).toBe('1 thing to review');
  });

  it('uses plural phrasing derived from the actual count, never a hard-coded number', () => {
    expect(resultsSummary(0)).toBe('0 things to review');
    expect(resultsSummary(3)).toBe('3 things to review');
    expect(resultsSummary(12)).toBe('12 things to review');
  });
});

describe('actionButtonFor', () => {
  it('shows the Review button, disabled, when there is no selection to review', () => {
    expect(actionButtonFor({ kind: 'empty' })).toEqual({ kind: 'review', disabled: true, label: MESSAGES.reviewButton });
  });

  it('enables the Review button once a selection is available', () => {
    expect(actionButtonFor({ kind: 'ready', preview: 'x' })).toEqual({ kind: 'review', disabled: false, label: MESSAGES.reviewButton });
  });

  it('keeps the Review button visible but disabled while a request is loading, with progress-communicating copy', () => {
    expect(actionButtonFor({ kind: 'loading' })).toEqual({ kind: 'review', disabled: true, label: MESSAGES.loadingButton });
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

  it('gives auth-required a "Connect" affordance, not a raw "Save"', () => {
    expect(actionButtonFor({ kind: 'auth-required' })).toEqual({ kind: 'save', disabled: false, label: MESSAGES.connectButton });
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

describe('finding navigation', () => {
  it('starts inactive: previous is always disabled, next is enabled whenever findings exist', () => {
    expect(canGoToPreviousFinding(null)).toBe(false);
    expect(canGoToNextFinding(null, 3)).toBe(true);
    expect(canGoToNextFinding(null, 0)).toBe(false);
  });

  it('advances forward one finding at a time, disabling next at the last one', () => {
    expect(nextFindingIndex(null, 3)).toBe(0);
    expect(nextFindingIndex(0, 3)).toBe(1);
    expect(nextFindingIndex(2, 3)).toBe(2);
    expect(canGoToNextFinding(2, 3)).toBe(false);
  });

  it('steps backward one finding at a time, disabling previous at the first one', () => {
    expect(previousFindingIndex(2, 3)).toBe(1);
    expect(previousFindingIndex(0, 3)).toBe(0);
    expect(canGoToPreviousFinding(0)).toBe(false);
    expect(canGoToPreviousFinding(1)).toBe(true);
  });

  it('never produces an index outside the finding list', () => {
    for (const total of [0, 1, 2, 5]) {
      let index: number | null = null;
      for (let step = 0; step < total + 3; step++) {
        index = nextFindingIndex(index, total);
        if (index !== null) expect(index).toBeLessThan(total);
      }
    }
  });
});
