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
  loading: 'Reviewing...',
  noFindings: 'No issues found.',
  authRequired: 'Authentication required.',
  rateLimited: 'Too many reviews right now. Please try again later.',
  providerUnavailable: 'Review temporarily unavailable.',
  invalidRequest: 'Could not review this selection.',
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
