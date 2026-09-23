/**
 * Minimal ambient declarations for the exact `chrome.*` surface this extension calls — enough
 * to typecheck popup.ts without depending on the full `@types/chrome` package. Extend only if a
 * new call site genuinely needs another member; this file is not meant to become a full API.
 */
declare namespace chrome.storage {
  interface StorageArea {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string[]): Promise<void>;
  }
  const local: StorageArea;
}

declare namespace chrome.tabs {
  interface Tab { id?: number; url?: string; }
  function query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
}

declare namespace chrome.scripting {
  interface InjectionTarget { tabId: number; }
  interface ScriptInjection<Result> { target: InjectionTarget; func: () => Result; }
  interface InjectionResult<Result> { result: Result; }
  function executeScript<Result>(injection: ScriptInjection<Result>): Promise<InjectionResult<Result>[]>;
}
