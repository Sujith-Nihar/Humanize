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
  // `args` (when present) are structured-cloned into the page and passed as `func`'s own
  // parameters; `func` itself must be self-contained (see highlight.ts's doc comment) — Chrome
  // reruns its source standalone in the page, not this closure.
  interface ScriptInjection<Args extends unknown[], Result> {
    target: InjectionTarget;
    func: (...args: Args) => Result;
    args?: Args;
  }
  interface InjectionResult<Result> { result: Result; }
  function executeScript<Args extends unknown[], Result>(injection: ScriptInjection<Args, Result>): Promise<InjectionResult<Result>[]>;
}
