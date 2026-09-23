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

/** User-facing copy only. Never a raw model output, a provider name, a stack trace, or a code. */
export const MESSAGES = {
  empty: 'Select text on a webpage to review it.',
  reviewSelectedText: 'Review selected text',
  reviewButton: 'Review',
  retryButton: 'Try again',
  loading: 'Reviewing...',
  noFindings: 'No issues found.',
  noFindingsDetail: 'This does not guarantee the text is entirely human-written or free of AI involvement — it means no issues matched the current checks.',
  authRequired: 'Authentication required.',
  rateLimited: 'Too many reviews right now. Please try again later.',
  providerUnavailable: 'Review temporarily unavailable. Please try again.',
  invalidRequest: 'Could not review this selection. Please try again.',
  couldNotLocate: "Couldn't locate this text on the page.",
} as const;

/** Truncated only for display; never sent anywhere and never logged. */
export function previewOf(selectedText: string, maxChars = 80): string {
  const trimmed = selectedText.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
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

export function messageFor(view: PopupView): string {
  switch (view.kind) {
    case 'empty': return MESSAGES.empty;
    case 'ready': return MESSAGES.reviewSelectedText;
    case 'loading': return MESSAGES.loading;
    case 'no-findings': return MESSAGES.noFindings;
    case 'auth-required': return MESSAGES.authRequired;
    case 'rate-limited': return MESSAGES.rateLimited;
    case 'provider-unavailable': return MESSAGES.providerUnavailable;
    case 'invalid-request': return MESSAGES.invalidRequest;
    case 'findings': return '';
  }
}

/** A secondary, non-alarming line of detail shown under the main message. Empty when a view has
 * nothing more to add — most views don't need one. */
export function detailFor(view: PopupView): string {
  return view.kind === 'no-findings' ? MESSAGES.noFindingsDetail : '';
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
    case 'loading': return { kind: 'review', disabled: true, label: MESSAGES.reviewButton };
    case 'findings':
    case 'no-findings':
    case 'rate-limited':
    case 'provider-unavailable':
    case 'invalid-request':
      return { kind: 'retry', disabled: false, label: MESSAGES.retryButton };
    case 'auth-required':
      return { kind: 'save', disabled: false, label: 'Save' };
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
