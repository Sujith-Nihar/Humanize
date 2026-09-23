import { describe, expect, it, vi } from 'vitest';
import { createChromeCredentialStore, createDevCredentialStore } from './src/credentials.js';
import type { StorageArea } from './src/credentials.js';

function memoryStorage(initial: Record<string, unknown> = {}): StorageArea {
  const data = { ...initial };
  return {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]))),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
    remove: vi.fn(async (keys: string[]) => { for (const key of keys) delete data[key]; }),
  };
}

describe('createChromeCredentialStore', () => {
  it('returns null when no credential has ever been stored', async () => {
    const store = createChromeCredentialStore(memoryStorage());
    expect(await store.getCredential()).toBeNull();
  });

  it('returns a stored credential and forgets it once cleared', async () => {
    const storage = memoryStorage({ 'humanize.extension.credential': 'stored-token' });
    const store = createChromeCredentialStore(storage);
    expect(await store.getCredential()).toBe('stored-token');
    await store.clearCredential();
    expect(await store.getCredential()).toBeNull();
  });

  it('treats a non-string or empty stored value as no credential at all', async () => {
    for (const bad of [42, {}, '']) {
      const store = createChromeCredentialStore(memoryStorage({ 'humanize.extension.credential': bad }));
      expect(await store.getCredential()).toBeNull();
    }
  });

  it('persists a credential the caller supplies, without validating or issuing it', async () => {
    const storage = memoryStorage();
    const store = createChromeCredentialStore(storage);
    await store.setCredential('a-development-credential');
    expect(await store.getCredential()).toBe('a-development-credential');
    expect(storage.set).toHaveBeenCalledWith({ 'humanize.extension.credential': 'a-development-credential' });
  });
});

describe('createDevCredentialStore', () => {
  it('returns exactly the fixture value it was constructed with, never a hard-coded one', async () => {
    const store = createDevCredentialStore('dev-fixture-token');
    expect(await store.getCredential()).toBe('dev-fixture-token');
  });

  it('reports no credential when constructed with none, rather than inventing one', async () => {
    const store = createDevCredentialStore(null);
    expect(await store.getCredential()).toBeNull();
  });
});
