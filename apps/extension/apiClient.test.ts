import { describe, expect, it, vi } from 'vitest';
import { submitReview } from './src/apiClient.js';
import type { BrowserText } from './src/types.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const browserText: BrowserText = {
  schemaVersion: 'humanize-browsertext-v1', requestId,
  text: 'Unlock unprecedented potential with our cutting-edge platform.',
  characterRange: { start: 0, end: 30 }, sourceType: 'webpage_selection', language: 'en',
};
const jsonResponse = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('submitReview', () => {
  it('sends the credential only in the Authorization header, never in the body or URL', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [] }));
    await submitReview(browserText, { baseUrl: 'https://api.example.com', credential: 'secret-actor-token', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(calledUrl)).not.toContain('secret-actor-token');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-actor-token');
    expect(String(init?.body ?? '')).not.toContain('secret-actor-token');
  });

  it('never logs the submitted text or the credential', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn(() => jsonResponse(200, { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [] }));
      await submitReview(browserText, { baseUrl: 'https://api.example.com', credential: 'secret-actor-token', fetchImpl });
      for (const spy of [logSpy, errorSpy, warnSpy]) {
        for (const call of spy.mock.calls) {
          const serialized = JSON.stringify(call);
          expect(serialized).not.toContain(browserText.text);
          expect(serialized).not.toContain('secret-actor-token');
        }
      }
    } finally { logSpy.mockRestore(); errorSpy.mockRestore(); warnSpy.mockRestore(); }
  });

  it('maps 401/429/5xx/other to safe, fixed codes without leaking the response body', async () => {
    for (const [status, code] of [[401, 'UNAUTHENTICATED'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE'], [502, 'PROVIDER_UNAVAILABLE'], [400, 'INVALID_REQUEST']] as const) {
      const fetchImpl = vi.fn(() => jsonResponse(status, { error: 'INTERNAL DETAIL THAT MUST NOT LEAK' }));
      const result = await submitReview(browserText, { baseUrl: 'https://api.example.com', credential: 'token', fetchImpl });
      expect(result).toEqual({ ok: false, code });
    }
  });

  it('maps a network/transport failure to a safe code without leaking the exception message', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(Error('connection to postgres://user:pass@host failed')));
    const result = await submitReview(browserText, { baseUrl: 'https://api.example.com', credential: 'token', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'NETWORK_ERROR' });
  });

  it('refuses a non-HTTPS, non-local endpoint rather than sending the credential in the clear', async () => {
    const fetchImpl = vi.fn();
    const result = await submitReview(browserText, { baseUrl: 'http://api.example.com', credential: 'token', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'NETWORK_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows plain HTTP only for a local development endpoint', async () => {
    const fetchImpl = vi.fn(() => jsonResponse(200, { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [] }));
    const result = await submitReview(browserText, { baseUrl: 'http://127.0.0.1:3001', credential: 'token', fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('returns the successful findings on a 200 response', async () => {
    const finding = { category: 'ai_like_generic', severity: 'minor', exactText: 'Unlock unprecedented potential', range: { start: 0, end: 30 }, explanation: 'Broad promotional wording.', confidence: 0.9 };
    const fetchImpl = vi.fn(() => jsonResponse(200, { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [finding] }));
    const result = await submitReview(browserText, { baseUrl: 'https://api.example.com', credential: 'token', fetchImpl });
    expect(result).toEqual({ ok: true, response: { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [finding] } });
  });
});
