import type { BrowserReviewResponse, BrowserText } from './types.js';

export type ReviewErrorCode = 'UNAUTHENTICATED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_REQUEST' | 'NETWORK_ERROR';
export type ReviewResult =
  | { ok: true; response: BrowserReviewResponse }
  | { ok: false; code: ReviewErrorCode };

export interface ReviewClientOptions {
  /** Origin of the Browser Review API, e.g. `https://api.example.com` or `http://127.0.0.1:3001` for local development. */
  baseUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20000;

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Sends exactly one BrowserText request and maps the response to a small, safe result — never
 * the raw response body, never a caught exception's message. The credential travels only in the
 * `Authorization` header, never in the body, a query string, or anywhere logged. Provider,
 * model, timeout, retry count and verification behaviour are entirely server-controlled: this
 * client sends only the fields `BrowserText` defines and nothing a page or user could use to
 * influence them.
 */
export async function submitReview(browserText: BrowserText, options: ReviewClientOptions): Promise<ReviewResult> {
  let url: URL;
  try { url = new URL('/extension/reviews', options.baseUrl); }
  catch { return { ok: false, code: 'NETWORK_ERROR' }; }
  // A non-HTTPS, non-local endpoint would send the credential and the selected text in the clear.
  if (url.protocol !== 'https:' && !isLocalHostname(url.hostname)) return { ok: false, code: 'NETWORK_ERROR' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.credential}` },
      body: JSON.stringify(browserText),
      signal: controller.signal,
    });
    if (response.status === 401) return { ok: false, code: 'UNAUTHENTICATED' };
    if (response.status === 429) return { ok: false, code: 'RATE_LIMITED' };
    if (response.status >= 500) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
    if (!response.ok) return { ok: false, code: 'INVALID_REQUEST' };
    const data = (await response.json()) as Partial<BrowserReviewResponse>;
    if (!Array.isArray(data.findings) || typeof data.requestId !== 'string') return { ok: false, code: 'INVALID_REQUEST' };
    return { ok: true, response: data as BrowserReviewResponse };
  } catch {
    // Covers network failure, abort-on-timeout and a non-JSON body alike; never surfaced verbatim.
    return { ok: false, code: 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timeout);
  }
}
