// The real browser entry point. Deliberately thin: everything decision-worthy (building the
// request, calling the API, mapping outcomes to a view) lives in controller.ts/popupState.ts,
// which are unit-tested with mocked browser APIs. This file only wires the real `chrome.*`
// surface and the DOM to those pure functions, and is exercised by manual/E2E testing, not by
// the unit suite (per Step 8's instruction: real browser APIs are mocked, not required, in
// unit tests).
import { createChromeCredentialStore } from './credentials.js';
import { reviewSelection } from './controller.js';
import { originMetadataFromUrl } from './selection.js';
import {
  LOADING_CHECKS, MESSAGES, actionButtonFor, canGoToNextFinding, canGoToPreviousFinding,
  canStartReview, copyFor, nextFindingIndex, previewOf, previousFindingIndex, resultsSummary, viewForOutcome,
} from './popupState.js';
import type { PopupView } from './popupState.js';
import { clearHighlightInPage, highlightArgsFor, locateAndHighlightInPage } from './highlight.js';
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

// Finding-navigation state. `activeFindingIndex` is `null` until the user explicitly clicks a
// card or a nav arrow — nothing on the page is ever highlighted before that first interaction.
let currentFindings: BrowserFinding[] = [];
let activeFindingIndex: number | null = null;
let cardElements: HTMLElement[] = [];
let statusEl: HTMLParagraphElement | null = null;
let syncNav: (() => void) | null = null;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

function setHeaderLoading(isLoading: boolean): void {
  document.getElementById('brand-status')?.classList.toggle('is-loading', isLoading);
}

function focusPrimaryControl(): void {
  const control = root?.querySelector<HTMLElement>('button:not([disabled]), input, [role="button"]');
  control?.focus();
}

function appendActionButton(view: PopupView, onReview: () => void): void {
  if (!root) return;
  const action = actionButtonFor(view);
  if (action.kind === 'none') return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-primary';
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

/** Removes any page highlight without creating a new one — used whenever a finding is
 * deactivated or a new review is about to start, so a stale highlight never lingers. */
async function clearHighlight(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clearHighlightInPage });
  } catch { /* best-effort */ }
}

/**
 * The single place that changes which finding is "active" — used by both a direct card click and
 * the prev/next nav arrows, so highlighting and card/nav visuals can never drift out of sync with
 * each other. Reuses `highlightFinding`/`clearHighlight` rather than any second highlighting path.
 */
function activateFinding(index: number | null): void {
  activeFindingIndex = index;
  cardElements.forEach((card, i) => {
    const isActive = i === index;
    card.classList.toggle('active', isActive);
    card.setAttribute('aria-current', isActive ? 'true' : 'false');
    const hint = card.querySelector<HTMLElement>('.finding-hint');
    if (hint) hint.textContent = isActive ? MESSAGES.shownOnPage : MESSAGES.viewOnPage;
  });
  syncNav?.();
  if (statusEl) statusEl.textContent = '';

  if (index === null) {
    void clearHighlight();
    return;
  }
  const finding = currentFindings[index];
  if (!finding) return;
  void highlightFinding(finding).then(result => {
    if (statusEl && !result.ok) statusEl.textContent = MESSAGES.couldNotLocate;
  });
}

function buildNav(total: number): HTMLElement {
  const nav = document.createElement('div');
  nav.className = 'finding-nav';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'nav-arrow';
  prev.setAttribute('aria-label', MESSAGES.previousFinding);
  prev.textContent = '←';

  const position = document.createElement('span');
  position.className = 'nav-position';
  position.setAttribute('aria-live', 'polite');

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'nav-arrow';
  next.setAttribute('aria-label', MESSAGES.nextFinding);
  next.textContent = '→';

  const sync = () => {
    prev.disabled = !canGoToPreviousFinding(activeFindingIndex);
    next.disabled = !canGoToNextFinding(activeFindingIndex, total);
    position.textContent = `${(activeFindingIndex ?? 0) + 1} of ${total}`;
  };
  prev.addEventListener('click', () => activateFinding(previousFindingIndex(activeFindingIndex, total)));
  next.addEventListener('click', () => activateFinding(nextFindingIndex(activeFindingIndex, total)));

  syncNav = sync;
  sync();
  nav.append(prev, position, next);
  return nav;
}

function buildFindingCard(finding: BrowserFinding, index: number): HTMLElement {
  const card = document.createElement('div');
  card.className = 'finding-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-current', 'false');
  card.setAttribute('aria-label', `${finding.category.replace(/_/g, ' ')}, ${finding.severity} severity: "${finding.exactText}"`);
  if (!prefersReducedMotion()) card.style.animationDelay = `${Math.min(index, 6) * 50}ms`;

  const header = document.createElement('div');
  header.className = 'finding-header';
  const category = document.createElement('span');
  category.className = 'finding-category';
  category.textContent = finding.category.replace(/_/g, ' ');
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

  const hint = document.createElement('span');
  hint.className = 'finding-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = MESSAGES.viewOnPage;

  card.append(header, quote, explanation, hint);

  const activate = () => activateFinding(index);
  card.addEventListener('click', activate);
  card.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  });

  return card;
}

function renderFindings(view: Extract<PopupView, { kind: 'findings' }>): void {
  if (!root) return;
  currentFindings = view.findings;
  activeFindingIndex = null;
  cardElements = [];
  syncNav = null;

  const header = document.createElement('div');
  header.className = 'results-header';
  const title = document.createElement('p');
  title.className = 'results-title';
  title.textContent = 'Review complete';
  const count = document.createElement('p');
  count.className = 'results-count';
  count.textContent = resultsSummary(view.findings.length);
  header.append(title, count);
  root.appendChild(header);

  if (view.findings.length > 1) root.appendChild(buildNav(view.findings.length));

  const list = document.createElement('div');
  list.className = 'finding-list';
  cardElements = view.findings.map((finding, index) => buildFindingCard(finding, index));
  list.append(...cardElements);
  root.appendChild(list);

  statusEl = document.createElement('p');
  statusEl.className = 'highlight-status';
  statusEl.setAttribute('aria-live', 'polite');
  root.appendChild(statusEl);

  appendActionButton(view, () => {});
}

function renderReady(view: Extract<PopupView, { kind: 'ready' }>): void {
  if (!root) return;
  const card = document.createElement('div');
  card.className = 'selection-card';
  const label = document.createElement('p');
  label.className = 'selection-label';
  label.textContent = 'Review this text';
  const quote = document.createElement('p');
  quote.className = 'selection-quote';
  quote.textContent = `"${view.preview}"`;
  const count = currentSelectionText.length;
  const meta = document.createElement('p');
  meta.className = 'selection-meta';
  meta.textContent = `${count} character${count === 1 ? '' : 's'} selected`;
  card.append(label, quote, meta);
  root.appendChild(card);
}

function renderLoading(): void {
  if (!root) return;
  const wrap = document.createElement('div');
  wrap.className = 'loading';
  const title = document.createElement('p');
  title.className = 'loading-title';
  title.textContent = MESSAGES.loadingTitle;
  const list = document.createElement('ul');
  list.className = 'loading-checks';
  for (const [index, label] of LOADING_CHECKS.entries()) {
    const item = document.createElement('li');
    item.style.setProperty('--i', String(index));
    item.textContent = label;
    list.appendChild(item);
  }
  wrap.append(title, list);
  root.appendChild(wrap);
}

function renderStatus(view: PopupView): void {
  if (!root) return;
  const copy = copyFor(view);
  if (!copy) return;
  const wrap = document.createElement('div');
  wrap.className = `status status-${view.kind}`;
  if (view.kind === 'no-findings' || view.kind === 'auth-required' || view.kind === 'rate-limited' || view.kind === 'provider-unavailable' || view.kind === 'invalid-request') {
    const icon = document.createElement('div');
    icon.className = 'status-icon';
    icon.setAttribute('aria-hidden', 'true');
    wrap.appendChild(icon);
  }
  const title = document.createElement('p');
  title.className = 'status-title';
  title.textContent = copy.title;
  const detail = document.createElement('p');
  detail.className = 'status-detail';
  detail.textContent = copy.detail;
  wrap.append(title, detail);
  root.appendChild(wrap);
}

function render(view: PopupView): void {
  if (!root) return;
  root.textContent = '';
  root.className = `state-${view.kind}`;
  setHeaderLoading(view.kind === 'loading');

  if (view.kind === 'findings') {
    renderFindings(view);
    focusPrimaryControl();
    return;
  }

  if (view.kind === 'ready') {
    renderReady(view);
    appendActionButton(view, () => { void runReview(); });
    focusPrimaryControl();
    return;
  }

  if (view.kind === 'loading') {
    renderLoading();
    appendActionButton(view, () => {});
    return;
  }

  renderStatus(view);

  if (view.kind === 'auth-required') {
    // Development-only affordance: credential issuance is unresolved (ADR-040), so this is
    // storage only — it never validates, issues, or contacts anything. The value the user
    // pastes here must already have been minted some other way (e.g. HUMANIZE_EXTENSION_DEV_
    // CREDENTIAL configured on a local API instance) and is never logged or displayed back.
    const form = document.createElement('div');
    form.className = 'auth-form';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Access key';
    input.setAttribute('aria-label', 'Humanize access key');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-primary';
    button.textContent = MESSAGES.connectButton;
    button.addEventListener('click', () => {
      const value = input.value.trim();
      input.value = '';
      if (value) void credentials.setCredential(value).then(init);
    });
    form.append(input, button);
    const privacy = document.createElement('p');
    privacy.className = 'auth-privacy';
    privacy.textContent = 'Stored only on this device. Never shared with the page you’re reviewing.';
    root.append(form, privacy);
    input.focus();
    return;
  }

  appendActionButton(view, () => { void runReview(); });
  focusPrimaryControl();
}

async function runReview(): Promise<void> {
  if (reviewInFlight) return;
  reviewInFlight = true;
  currentFindings = [];
  activeFindingIndex = null;
  void clearHighlight();
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
  void clearHighlight();
  try {
    const { text } = await readSelectionFromActiveTab();
    currentSelectionText = text.trim();
  } catch {
    currentSelectionText = '';
  }
  render(currentSelectionText ? { kind: 'ready', preview: previewOf(currentSelectionText) } : { kind: 'empty' });
}

void init();
