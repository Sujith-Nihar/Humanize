import { buildBrowserText } from './selection.js';
import type { OriginMetadata, SourceType } from './selection.js';
import { submitReview } from './apiClient.js';
import type { ReviewErrorCode } from './apiClient.js';
import type { ExtensionCredentialStore } from './credentials.js';
import type { BrowserFinding } from './types.js';

export type ReviewOutcome =
  | { state: 'no-credential' }
  | { state: 'empty-selection' }
  | { state: 'success'; findings: BrowserFinding[] }
  | { state: 'error'; code: ReviewErrorCode };

export interface ReviewSelectionInput {
  selectedText: string;
  requestId: string;
  sourceType?: SourceType;
  originMetadata?: OriginMetadata;
  credentials: ExtensionCredentialStore;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * The one entry point tying the pieces together: credential → BrowserText → submit → outcome.
 * The credential is checked first, before anything is built or sent — an unauthenticated caller
 * never reaches `buildBrowserText` or `submitReview`, so no request is attempted at all.
 */
export async function reviewSelection(input: ReviewSelectionInput): Promise<ReviewOutcome> {
  const credential = await input.credentials.getCredential();
  if (!credential) return { state: 'no-credential' };

  const built = buildBrowserText({
    selectedText: input.selectedText, requestId: input.requestId,
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
    ...(input.originMetadata ? { originMetadata: input.originMetadata } : {}),
  });
  if (!built.ok) return { state: 'empty-selection' };

  const result = await submitReview(built.browserText, {
    baseUrl: input.baseUrl, credential,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!result.ok) return { state: 'error', code: result.code };
  return { state: 'success', findings: result.response.findings };
}
