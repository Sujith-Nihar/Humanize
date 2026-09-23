import { describe, expect, it, vi } from 'vitest';
import { reviewSelection } from './src/controller.js';
import type { ExtensionCredentialStore } from './src/credentials.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const jsonResponse = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const noCredential: ExtensionCredentialStore = { getCredential: async () => null, setCredential: async () => {}, clearCredential: async () => {} };
const withCredential = (credential: string): ExtensionCredentialStore => ({ getCredential: async () => credential, setCredential: async () => {}, clearCredential: async () => {} });

describe('reviewSelection', () => {
  it('8. never makes an API request when no credential is present', async () => {
    const fetchImpl = vi.fn();
    const outcome = await reviewSelection({
      selectedText: 'Unlock unprecedented potential.', requestId, credentials: noCredential,
      baseUrl: 'https://api.example.com', fetchImpl,
    });
    expect(outcome).toEqual({ state: 'no-credential' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports empty-selection without ever calling the API, once a credential exists', async () => {
    const fetchImpl = vi.fn();
    const outcome = await reviewSelection({
      selectedText: '   ', requestId, credentials: withCredential('token'),
      baseUrl: 'https://api.example.com', fetchImpl,
    });
    expect(outcome).toEqual({ state: 'empty-selection' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('submits a review once a credential and non-empty selection are both present', async () => {
    const fetchImpl = vi.fn(() => jsonResponse(200, { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [] }));
    const outcome = await reviewSelection({
      selectedText: 'Unlock unprecedented potential.', requestId, credentials: withCredential('token'),
      baseUrl: 'https://api.example.com', fetchImpl,
    });
    expect(outcome).toEqual({ state: 'success', findings: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('propagates a mapped error code without ever exposing the underlying response', async () => {
    const fetchImpl = vi.fn(() => jsonResponse(401, { error: 'internal detail' }));
    const outcome = await reviewSelection({
      selectedText: 'Unlock unprecedented potential.', requestId, credentials: withCredential('token'),
      baseUrl: 'https://api.example.com', fetchImpl,
    });
    expect(outcome).toEqual({ state: 'error', code: 'UNAUTHENTICATED' });
  });

  it('never logs the selected text across a full review attempt', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn(() => jsonResponse(200, { requestId, schemaVersion: 'humanize-browsertext-v1', findings: [] }));
      const text = 'A sentence that must never appear in any log line.';
      await reviewSelection({ selectedText: text, requestId, credentials: withCredential('token'), baseUrl: 'https://api.example.com', fetchImpl });
      for (const call of logSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(text);
    } finally { logSpy.mockRestore(); }
  });
});
