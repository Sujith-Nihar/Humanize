import type { ReviewOutcome } from './controller.js';
import type { BrowserFinding } from './types.js';

export type PopupView =
  | { kind: 'empty' }
  | { kind: 'ready'; preview: string }
  | { kind: 'loading' }
  | { kind: 'findings'; findings: BrowserFinding[] }
  | { kind: 'no-findings' }
  | { kind: 'auth-required' }
  | { kind: 'rate-limited' }
  | { kind: 'provider-unavailable' }
  | { kind: 'invalid-request' };

export const BRAND = {
  name: 'Humanize',
  tagline: 'Make your writing sound like you.',
} as const;

/** User-facing copy only — button labels and fixed strings that aren't a {title, detail} pair.
 * Never a raw model output, a provider name, a stack trace, or an internal code. */
export const MESSAGES = {
  reviewButton: 'Review selection',
  retryButton: 'Review again',
  connectButton: 'Connect',
  loadingTitle: 'Analyzing your writing',
  loadingButton: 'Reviewing…',
  couldNotLocate: "Couldn't find this text on the page.",
  previousFinding: 'Previous finding',
  nextFinding: 'Next finding',
  viewOnPage: 'View on page',
  shownOnPage: 'Shown on page',
} as const;

/** Decorative only — the API returns one response, never incremental per-check progress, so
 * these are never marked "done"; see popup.ts's indeterminate scanning animation. */
export const LOADING_CHECKS = ['Clarity', 'Repetition', 'Terminology', 'Generic phrasing'] as const;

export interface StatusCopy { readonly title: string; readonly detail: string; }

const STATUS_COPY = {
  empty: {
    title: 'Select text to begin',
    detail: 'Highlight a passage on the page, then reopen Humanize to review it.',
  },
  authRequired: {
    title: 'Connect Humanize',
    detail: 'Your Humanize account is required to review text.',
  },
  rateLimited: {
    title: "You're reviewing quickly",
    detail: 'Please wait a moment and try again.',
  },
  providerUnavailable: {
    title: "Humanize couldn't complete the review",
    detail: 'Something went wrong while analyzing this text.',
  },
  invalidRequest: {
    title: 'Something went wrong',
    detail: 'Please try again.',
  },
  noFindings: {
    title: 'Looks good',
    detail: "We didn't find anything that needs attention based on this review — that doesn't guarantee the text is entirely human-written or free of AI involvement.",
  },
} as const satisfies Record<string, StatusCopy>;

/** Truncated only for display; never sent anywhere and never logged. The full, untruncated
 * selection is what actually gets submitted for review (see popup.ts's `currentSelectionText`). */
export function previewOf(selectedText: string, maxChars = 140): string {
  const trimmed = selectedText.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/** "1 thing to review" / "3 things to review" — always derived from the actual finding count,
 * never a hard-coded number. */
export function resultsSummary(count: number): string {
  return count === 1 ? '1 thing to review' : `${count} things to review`;
}

/** Maps a completed review attempt to a view. The four documented HTTP-error buckets each get
 * their own, fixed, non-technical message — never the code, never the backend's own error body. */
export function viewForOutcome(outcome: ReviewOutcome): PopupView {
  switch (outcome.state) {
    case 'no-credential': return { kind: 'auth-required' };
    case 'empty-selection': return { kind: 'invalid-request' };
    case 'success': return outcome.findings.length ? { kind: 'findings', findings: outcome.findings } : { kind: 'no-findings' };
    case 'error':
      switch (outcome.code) {
        case 'UNAUTHENTICATED': return { kind: 'auth-required' };
        case 'RATE_LIMITED': return { kind: 'rate-limited' };
        case 'PROVIDER_UNAVAILABLE': return { kind: 'provider-unavailable' };
        case 'INVALID_REQUEST':
        case 'NETWORK_ERROR':
        default: return { kind: 'invalid-request' };
      }
  }
}

/** The {title, detail} pair for every view that's rendered as a plain status message — `null` for
 * views ('ready', 'loading', 'findings') that have their own bespoke layout instead. */
export function copyFor(view: PopupView): StatusCopy | null {
  switch (view.kind) {
    case 'empty': return STATUS_COPY.empty;
    case 'auth-required': return STATUS_COPY.authRequired;
    case 'rate-limited': return STATUS_COPY.rateLimited;
    case 'provider-unavailable': return STATUS_COPY.providerUnavailable;
    case 'invalid-request': return STATUS_COPY.invalidRequest;
    case 'no-findings': return STATUS_COPY.noFindings;
    case 'ready':
    case 'loading':
    case 'findings':
      return null;
  }
}

export type ActionButton =
  | { kind: 'review'; disabled: boolean; label: string }
  | { kind: 'retry'; disabled: boolean; label: string }
  | { kind: 'save'; disabled: boolean; label: string }
  | { kind: 'none' };

/**
 * The single source of truth for what the popup's primary button looks like in every state.
 * Every terminal state (success or failure) gets a `retry` affordance, so the popup can never
 * leave the user stuck without a way forward; `loading` always disables `review` rather than
 * hiding it, so a second click can never start a second request while one is in flight.
 */
export function actionButtonFor(view: PopupView): ActionButton {
  switch (view.kind) {
    case 'empty': return { kind: 'review', disabled: true, label: MESSAGES.reviewButton };
    case 'ready': return { kind: 'review', disabled: false, label: MESSAGES.reviewButton };
    case 'loading': return { kind: 'review', disabled: true, label: MESSAGES.loadingButton };
    case 'findings':
    case 'no-findings':
    case 'rate-limited':
    case 'provider-unavailable':
    case 'invalid-request':
      return { kind: 'retry', disabled: false, label: MESSAGES.retryButton };
    case 'auth-required':
      return { kind: 'save', disabled: false, label: MESSAGES.connectButton };
  }
}

/**
 * Whether clicking the review action right now should actually start a request. `inFlight` is
 * true for the whole span between the click that started a review and its outcome being
 * rendered, so a second click (or a stray keyboard-repeat event) during that span is refused here
 * even if, for whatever reason, the button's own `disabled` attribute did not stop it first.
 */
export function canStartReview(view: PopupView, inFlight: boolean): boolean {
  if (inFlight) return false;
  const action = actionButtonFor(view);
  return action.kind === 'review' && !action.disabled;
}

/**
 * Finding-navigation cursor logic — pure, so it's testable without a DOM. `activeIndex` is `null`
 * until the user has clicked a card or a nav arrow at least once; nothing on the page is ever
 * highlighted before that first explicit interaction.
 */
export function canGoToPreviousFinding(activeIndex: number | null): boolean {
  return activeIndex !== null && activeIndex > 0;
}
export function canGoToNextFinding(activeIndex: number | null, total: number): boolean {
  if (total === 0) return false;
  return activeIndex === null ? true : activeIndex < total - 1;
}
export function nextFindingIndex(activeIndex: number | null, total: number): number | null {
  if (total === 0) return null;
  if (activeIndex === null) return 0;
  return activeIndex < total - 1 ? activeIndex + 1 : activeIndex;
}
export function previousFindingIndex(activeIndex: number | null, total: number): number | null {
  if (activeIndex === null || total === 0) return activeIndex;
  return activeIndex > 0 ? activeIndex - 1 : activeIndex;
}

export type { BrowserFinding };
