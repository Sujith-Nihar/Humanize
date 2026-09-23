// The one genuinely shared, canonical contract this extension depends on. Reused rather than
// duplicated: @humanize/domain is exactly the intended cross-cutting home for BrowserText, and
// every other app in this monorepo already reuses domain types the same way.
import type { BrowserText } from '@humanize/domain';
export type { BrowserText };

/**
 * Mirrors the response shape `apps/api/src/extension.ts` returns, deliberately NOT imported from
 * `@humanize/api`: no app in this monorepo depends on another app's source (every cross-app
 * shared contract lives in `packages/`), and `apps/api`'s HTTP response types are local to that
 * app's route implementation, not a published package contract. A small structural mirror here
 * is safer than introducing a first apps-depending-on-apps precedent for a handful of fields.
 */
export interface BrowserFinding {
  category: string;
  severity: 'major' | 'minor' | 'nit';
  exactText: string;
  range: { start: number; end: number };
  explanation: string;
  confidence: number;
}
export interface BrowserReviewResponse {
  requestId: string;
  schemaVersion: string;
  findings: BrowserFinding[];
}
