/**
 * Credential issuance is unresolved (ADR-040) and is not solved here. This is only the
 * extension-side storage boundary: where an already-issued credential is held once the caller
 * has one, and how it is read back or cleared. No login flow, no token issuance, no backend.
 */
export interface ExtensionCredentialStore {
  getCredential(): Promise<string | null>;
  clearCredential(): Promise<void>;
}

/** The subset of `chrome.storage.local` this store needs, so it can be tested without `chrome`. */
export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

const STORAGE_KEY = 'humanize.extension.credential';

/**
 * Backed by the browser extension's own storage area — never `localStorage` (page-accessible),
 * never a cookie, never `chrome.storage.sync` (which would leave the machine).
 */
export function createChromeCredentialStore(storage: StorageArea): ExtensionCredentialStore {
  return {
    async getCredential() {
      const stored = await storage.get([STORAGE_KEY]);
      const value = stored[STORAGE_KEY];
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
    async clearCredential() {
      await storage.remove([STORAGE_KEY]);
    },
  };
}

/**
 * A fixed, in-memory credential for local development only. The value is a parameter this
 * function is called with — never an environment variable read here, never a literal secret
 * written into this file, never wired into any production build. A caller supplies it from a
 * development fixture that lives outside version control.
 */
export function createDevCredentialStore(devCredential: string | null): ExtensionCredentialStore {
  return {
    async getCredential() { return devCredential; },
    async clearCredential() { /* a fixed development fixture has nothing to clear */ },
  };
}
