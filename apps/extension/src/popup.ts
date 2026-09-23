// The real browser entry point. Deliberately thin: everything decision-worthy (building the
// request, calling the API, mapping outcomes to a view) lives in controller.ts/popupState.ts,
// which are unit-tested with mocked browser APIs. This file only wires the real `chrome.*`
// surface and the DOM to those pure functions, and is exercised by manual/E2E testing, not by
// the unit suite (per Step 8's instruction: real browser APIs are mocked, not required, in
// unit tests).
import { createChromeCredentialStore } from './credentials.js';
import { reviewSelection } from './controller.js';
import { originMetadataFromUrl } from './selection.js';
import { MESSAGES, actionButtonFor, canStartReview, detailFor, messageFor, previewOf, viewForOutcome } from './popupState.js';
import type { PopupView } from './popupState.js';
import { highlightArgsFor, locateAndHighlightInPage } from './highlight.js';
import type { HighlightPageResult } from './highlight.js';
import type { BrowserFinding } from './types.js';

// Configured per environment; a real deployment's API origin, never hard-coded here. The
// bundled default is a local development origin, matching apps/api's own default listen port —
// never a production URL.
declare const HUMANIZE_API_BASE_URL: string | undefined;
const API_BASE_URL = typeof HUMANIZE_API_BASE_URL === 'string' ? HUMANIZE_API_BASE_URL : 'http://127.0.0.1:3001';

const root = document.getElementById('root');
const credentials = createChromeCredentialStore(chrome.storage.local);

// The full selection this popup was opened with — never truncated. `previewOf` only ever
// shortens what is *shown*; whatever is actually reviewed always comes from here, so a long
// selection is never silently swapped for the shorter string the user sees on screen.
let currentSelectionText = '';
// Set for the whole span between a review starting and its outcome being rendered, so a second
// click (or an event that slips through a disabled button) can never start a second request.
let reviewInFlight = false;

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

function focusPrimaryControl(): void {
  const control = root?.querySelector<HTMLButtonElement | HTMLInputElement>('button, input');
  control?.focus();
}

function appendActionButton(view: PopupView, onReview: () => void): void {
  if (!root) return;
  const action = actionButtonFor(view);
  if (action.kind === 'none') return;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = action.label;
  button.disabled = action.disabled;
  if (action.kind === 'review') {
    // Belt-and-braces alongside `button.disabled`: re-checks the view and in-flight state at
    // click time, so a second request can never start even if some event slipped past the
    // button's own disabled state.
    button.addEventListener('click', () => { if (canStartReview(view, reviewInFlight)) onReview(); });
  }
  // A retry re-checks the current selection from scratch, exactly like opening the popup fresh —
  // the same path that already handles "no selection" vs. "selection present" correctly.
  if (action.kind === 'retry') button.addEventListener('click', () => { void init(); });
  root.appendChild(button);
}

/**
 * Runs the fixed, reviewed highlight function on demand, in direct response to the user clicking
 * a finding — never automatically. Any failure (no tab, no selection any more, a mismatched or
 * out-of-bounds range) is swallowed here into the same safe "couldn't locate" outcome; this must
 * never throw into the click handler, since a highlighting failure must leave the popup and its
 * findings exactly as usable as before.
 */
async function highlightFinding(finding: BrowserFinding): Promise<HighlightPageResult> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, reason: 'NO_SELECTION' };
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: locateAndHighlightInPage,
      args: [highlightArgsFor(finding)],
    });
    return injected?.result ?? { ok: false, reason: 'NO_SELECTION' };
  } catch {
    return { ok: false, reason: 'NO_SELECTION' };
  }
}

function renderFindings(view: Extract<PopupView, { kind: 'findings' }>): void {
  if (!root) return;
  const list = document.createElement('div');
  list.className = 'finding-list';

  const status = document.createElement('p');
  status.className = 'highlight-status';
  status.setAttribute('aria-live', 'polite');

  for (const finding of view.findings) {
    const card = document.createElement('div');
    card.className = 'finding-card';
    // Clickable, but never the only way to read a finding — clicking just attempts to locate and
    // highlight it on the page; the card and its text stay exactly as readable either way.
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const activate = () => {
      status.textContent = '';
      void highlightFinding(finding).then(result => {
        status.textContent = result.ok ? '' : MESSAGES.couldNotLocate;
      });
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });

    const header = document.createElement('div');
    header.className = 'finding-header';
    const category = document.createElement('span');
    category.className = 'finding-category';
    category.textContent = finding.category;
    const severity = document.createElement('span');
    severity.className = 'finding-severity';
    severity.dataset.severity = finding.severity;
    severity.textContent = finding.severity;
    header.append(category, severity);

    // The quoted text is exactly what the server returned in `exactText` — never re-derived,
    // truncated or otherwise altered before display.
    const quote = document.createElement('p');
    quote.className = 'finding-quote';
    quote.textContent = `"${finding.exactText}"`;

    const explanation = document.createElement('p');
    explanation.className = 'finding-explanation';
    explanation.textContent = finding.explanation;

    card.append(header, quote, explanation);
    list.appendChild(card);
  }
  root.append(list, status);
  appendActionButton(view, () => {});
}

function render(view: PopupView): void {
  if (!root) return;
  root.textContent = '';
  root.className = `state-${view.kind}`;

  if (view.kind === 'findings') {
    renderFindings(view);
    focusPrimaryControl();
    return;
  }

  const message = document.createElement('p');
  message.className = 'message';
  message.textContent = view.kind === 'ready' ? MESSAGES.reviewSelectedText : messageFor(view);
  root.appendChild(message);

  const detail = detailFor(view);
  if (detail) {
    const detailEl = document.createElement('p');
    detailEl.className = 'message-detail';
    detailEl.textContent = detail;
    root.appendChild(detailEl);
  }

  if (view.kind === 'ready') {
    const preview = document.createElement('p');
    preview.className = 'preview';
    preview.textContent = `"${view.preview}"`;
    root.appendChild(preview);
  }

  if (view.kind === 'auth-required') {
    // Development-only affordance: credential issuance is unresolved (ADR-040), so this is
    // storage only — it never validates, issues, or contacts anything. The value the user
    // pastes here must already have been minted some other way (e.g. HUMANIZE_EXTENSION_DEV_
    // CREDENTIAL configured on a local API instance) and is never logged or displayed back.
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Development credential';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Save';
    button.addEventListener('click', () => {
      const value = input.value.trim();
      input.value = '';
      if (value) void credentials.setCredential(value).then(init);
    });
    root.append(input, button);
    input.focus();
    return;
  }

  appendActionButton(view, () => { void runReview(); });
  focusPrimaryControl();
}

async function runReview(): Promise<void> {
  if (reviewInFlight) return;
  reviewInFlight = true;
  render({ kind: 'loading' });
  try {
    const { tabUrl } = await readSelectionFromActiveTab();
    const originMetadata = originMetadataFromUrl(tabUrl);
    const outcome = await reviewSelection({
      selectedText: currentSelectionText,
      requestId: crypto.randomUUID(),
      ...(originMetadata ? { originMetadata } : {}),
      credentials,
      baseUrl: API_BASE_URL,
    });
    render(viewForOutcome(outcome));
  } catch {
    // Any unexpected failure (a rejected chrome.* call, a thrown exception in a dependency) must
    // still resolve to a safe, actionable view — `loading` can never be the last render.
    render({ kind: 'invalid-request' });
  } finally {
    reviewInFlight = false;
  }
}

async function init(): Promise<void> {
  try {
    const { text } = await readSelectionFromActiveTab();
    currentSelectionText = text.trim();
  } catch {
    currentSelectionText = '';
  }
  render(currentSelectionText ? { kind: 'ready', preview: previewOf(currentSelectionText) } : { kind: 'empty' });
}

void init();
