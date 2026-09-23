// The real browser entry point. Deliberately thin: everything decision-worthy (building the
// request, calling the API, mapping outcomes to a view) lives in controller.ts/popupState.ts,
// which are unit-tested with mocked browser APIs. This file only wires the real `chrome.*`
// surface and the DOM to those pure functions, and is exercised by manual/E2E testing, not by
// the unit suite (per Step 8's instruction: real browser APIs are mocked, not required, in
// unit tests).
import { createChromeCredentialStore } from './credentials.js';
import { reviewSelection } from './controller.js';
import { originMetadataFromUrl } from './selection.js';
import { MESSAGES, messageFor, previewOf, viewForOutcome } from './popupState.js';
import type { PopupView } from './popupState.js';

// Configured per environment; a real deployment's API origin, never hard-coded here.
declare const HUMANIZE_API_BASE_URL: string | undefined;
const API_BASE_URL = typeof HUMANIZE_API_BASE_URL === 'string' ? HUMANIZE_API_BASE_URL : 'http://127.0.0.1:3001';

const root = document.getElementById('root');

/**
 * Runs a fixed, reviewed function inside the active tab to read the user's current selection.
 * This is the "browser selection API approach": the function is constant and this file's own
 * code, never anything from the page; it returns a string and nothing else, and is scoped to
 * the current tab only for the moment the user opened this popup (`activeTab`). It does not
 * read cookies, storage, form values, or any other page content, and it changes nothing on the
 * page — `window.getSelection()` alone is a pure read.
 */
async function readSelectionFromActiveTab(): Promise<{ text: string; tabUrl: string | undefined }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { text: '', tabUrl: undefined };
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.getSelection()?.toString() ?? '',
  });
  return { text: injected?.result ?? '', tabUrl: tab.url };
}

function render(view: PopupView): void {
  if (!root) return;
  root.textContent = '';
  if (view.kind === 'findings') {
    for (const finding of view.findings) {
      const item = document.createElement('div');
      item.textContent = `[${finding.category} / ${finding.severity}] "${finding.exactText}" — ${finding.explanation}`;
      root.appendChild(item);
    }
    return;
  }
  const message = document.createElement('div');
  message.textContent = view.kind === 'ready' ? `${MESSAGES.reviewSelectedText}: "${view.preview}"` : messageFor(view);
  root.appendChild(message);
  if (view.kind === 'ready') {
    const button = document.createElement('button');
    button.textContent = MESSAGES.reviewButton;
    button.addEventListener('click', () => { void runReview(view.preview); });
    root.appendChild(button);
  }
}

async function runReview(selectedText: string): Promise<void> {
  render({ kind: 'loading' });
  const { tabUrl } = await readSelectionFromActiveTab();
  const originMetadata = originMetadataFromUrl(tabUrl);
  const outcome = await reviewSelection({
    selectedText,
    requestId: crypto.randomUUID(),
    ...(originMetadata ? { originMetadata } : {}),
    credentials: createChromeCredentialStore(chrome.storage.local),
    baseUrl: API_BASE_URL,
  });
  render(viewForOutcome(outcome));
}

async function init(): Promise<void> {
  const { text } = await readSelectionFromActiveTab();
  const trimmed = text.trim();
  render(trimmed ? { kind: 'ready', preview: previewOf(trimmed) } : { kind: 'empty' });
}

void init();
