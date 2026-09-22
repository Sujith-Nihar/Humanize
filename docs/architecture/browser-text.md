# BrowserText contract design

Status: design only. No schema, endpoint, or extension code is implemented by this document.
Nothing here authorizes writing `packages/domain` changes, a new API route, or `apps/extension`;
that remains gated on the open questions below and on the scope limits already recorded in
[ADR-040](../adr/ADR-040.md).

## 1. Purpose

[ADR-040](../adr/ADR-040.md) authorized investigating a browser extension as a product surface
separate from the GitHub review pipeline, and named a conceptual `BrowserText` type for text a
user explicitly selects in their browser. This document is the next step: it works out the
conceptual contract — fields, validation, character-range semantics, origin metadata, privacy,
finding anchoring, and the API boundary — in enough detail that a future implementation ADR/task
could turn it into an actual Zod schema and endpoint. It intentionally stops short of that: no
schema is written, no route is added, and no code path is touched.

## 2. Relationship to ADR-040

ADR-040 ruled out reusing `ContentNodeSchema`/`ReviewSnapshotSchema` for browser text (they encode
GitHub repository/commit/blob/PR identity that browser text does not have) and ruled out four
alternatives (folding into the GitHub pipeline, calling providers directly from the browser,
reusing runner credentials, building a second review engine) in favor of a thin new input type
reusing the existing review/provider infrastructure. Everything below designs that input type and
its boundary. It does not revisit or relitigate those decisions; it assumes them. Every
non-authorization named in ADR-040's Scope section (no new endpoint, no schema implementation, no
dependency, no invariant change) applies equally here.

## 3. Repository ContentNode vs BrowserText

| | `ContentNode` (existing) | `BrowserText` (proposed) |
|---|---|---|
| Anchored to | repository → commit → file → parser node → source offsets | user request/session → selected text → optional browser origin metadata |
| Identity fields | `repositoryId`, `commitSha`, `blobSha`, `filePath`, `parser`/`parserVersion`, `stableKey` ([`packages/domain/src/index.ts:24`](../../packages/domain/src/index.ts)) | none of the above — no repository, no commit, no blob, no file, no parser identity |
| Coordinates | `startLine`/`endLine`/`startOffset`/`endOffset` against a real file, plus `segments` mapping decoded text back to raw source (for entities/escapes) | offsets against the submitted text string only (§6) — there is no raw/decoded distinction because there is no source file to decode from |
| How review anchors it | `reviewNodes` requires `node.repositoryId`/`node.commitSha` to match the `ReviewSnapshot` under review, or throws `NODE_OUT_OF_SNAPSHOT` ([`packages/review/src/pipeline.ts:106`](../../packages/review/src/pipeline.ts)) | has no snapshot to match; anchored only to the request/session it arrived in (§9 designs the replacement anchoring mechanism) |
| Suggestion safety | `buildSuggestion` re-parses the whole file and structurally proves exactly one node's text changed ([`packages/suggestions/src/index.ts:48`](../../packages/suggestions/src/index.ts)) | no file to re-parse — see §10 |

**This document does not invent repository identity for browser text.** No field below is a
substitute `repositoryId`, `commitSha`, or `filePath`; none is synthesized, defaulted, or coerced
to satisfy `ContentNodeSchema`. `BrowserText` is its own type from the ground up.

## 4. Proposed BrowserText fields

Conceptual only — no Zod schema is written here. "Persisted?" describes default (ephemeral)
behavior per [ADR-040's Privacy section](../adr/ADR-040.md); a future explicit opt-in could change
some of these, as noted.

| Field | Purpose | Type | Required | Validation | Persisted by default? | Sent to LLM? |
|---|---|---|---|---|---|---|
| `schemaVersion` | Protocol/schema compatibility gate, checked before anything else is processed — same purpose as `RunnerCapabilitiesSchema.schemaVersion` and the runner routes' `incompatible()` pre-check ([`apps/api/src/runner.ts:41`](../../apps/api/src/runner.ts)) | literal string, e.g. `'humanize-browsertext-v1'` | required | exact literal match; mismatch refused before any other validation, mirroring the runner protocol's "reject before any state change" rule | No — a protocol constant, not content | No |
| `requestId` | Idempotency and tracing for one submitted review request (distinct from a session) | UUID string | required | UUID v4 format; used the way `leaseId`/`runId` are used elsewhere for correlation, not as a security boundary by itself | Transiently, for an idempotency window only (parallel to webhook delivery dedup, INV-009) — not retained beyond that window by default | No |
| `sessionIdentity` | Groups requests from one browser session/install for rate limiting, quota, and abuse correlation once an auth mechanism exists | opaque string (format defined by the deferred auth design — ADR-040 explicitly leaves this open) | required in principle (some identity must exist for abuse control), mechanism undesigned | format/mechanism is an open question (§14); until designed, this field is a placeholder, not a proposal for a specific token scheme | Only as long as abuse-control accounting needs it; never indefinitely, never alongside retained text | No — identity, not content |
| `text` | The reviewable content itself — the user's selection, verbatim | string | required | non-empty after trimming; valid Unicode (no lone surrogates); no disallowed control characters other than `\n`/`\t` (parallel to the control-character refusal already applied to suggestion replacements, [`packages/suggestions/src/encode.ts`](../../packages/suggestions/src/encode.ts)); bounded length (§4.1) | No by default; only under explicit user opt-in, and only for the minimum retention period the opt-in states | **Yes** — this is the content under review; it must cross the same prompt-injection fence as repository content (§10, §11) |
| `characterRange` | Identifies which part of `text` a UI should treat as "the selection" when `text` itself was captured with some surrounding context (see §6) — for the common case where the whole `text` value *is* the selection, this is `{start: 0, end: text.length}` | `{start: number, end: number}`, UTF-16 code units, half-open, relative to `text` only | required | `0 <= start <= end <= text.length`; must not split a UTF-16 surrogate pair (§6) | Same lifetime as `text` | No — it is a position, not content; findings carry their own ranges derived server-side (§9), not this one |
| `sourceType` | Coarse discriminator for where the text came from, since trust/structure differs (a generic page selection vs. a specific supported editor integration) | closed enum, e.g. `'webpage_selection'` \| `'editor_selection'` \| `'devtools_selection'` | required | must be one of a fixed, versioned set; unknown value rejected (fail closed, matching how `Category`/`ContentKind` enums are validated elsewhere) | Same lifetime as `text` if retained at all | No — informs server-side routing/config, not reviewable prose (see note below) |
| `originMetadata.hostname` | Coarse site identity, useful for future per-site allow/deny lists or diagnostics | string, hostname only (no path, query, or fragment) | optional | RFC-compliant hostname shape; explicitly never the full URL (§7) | Only under explicit opt-in | No |
| `originMetadata.documentType` | Coarse content-type hint (e.g. `'html'`, `'markdown'`, `'plaintext'`) that could eventually inform routing the way `ContentKind` does today | closed enum | optional | fixed set, unknown rejected | Only under explicit opt-in | No |
| `originMetadata.browserFamily` | Coarse client family/version for compatibility diagnostics (not a fingerprinting-grade user agent string) | string, e.g. `'chrome/128'` | optional | short allow-listed pattern | Only under explicit opt-in, and only for diagnostics, never analytics | No |
| `maxTextLength` (a limit, not a field) | Bounds `text` — see §4.1 | — | — | — | — | — |

Note on `sourceType` reaching the LLM: routing decisions in the existing pipeline (`routeNode`,
[`packages/review/src/router.ts`](../../packages/review/src/router.ts)) are made from
`ContentNode.kind`/length **before** the model is ever called, and the model is never told the
routing rationale, only the categories it should evaluate. `BrowserText.sourceType` would follow
the same pattern if it is ever used for routing at all — it selects which categories are asked
for, deterministically, server-side; it is not part of the reviewer's prompt input.

### 4.1 Size limit

`text` should be bounded, not unbounded. The existing `ContentNode.text` cap is 10,000 UTF-16
units (`LIMITS.nodeChars`, [`packages/domain/src/index.ts:111`](../../packages/domain/src/index.ts)),
chosen for a single extracted string from a repository file. A browser selection is conceptually
similar (a paragraph, a heading, a short passage a user is asking about) and reusing that same
ceiling as a starting point is reasonable, but this is a **placeholder for future tuning**, not a
final number — an actual limit needs its own decision informed by real usage and by the request
size limits discussed in §11, not invented here.

## 5. Validation rules (summary)

- `schemaVersion` checked first, before any other field is inspected — an incompatible client must
  be refused before it can influence any state, exactly as the runner registration route already
  does ([`apps/api/src/runner.ts:62`](../../apps/api/src/runner.ts) `incompatible(body.capabilities)`).
- `text`: non-empty, valid Unicode, bounded length (§4.1), no disallowed control characters.
- `characterRange`: bounds-checked against `text.length`, `start <= end`, never splits a surrogate
  pair (§6).
- `sourceType`, `originMetadata.documentType`: closed enums, unknown values rejected rather than
  ignored — the same "fail closed on an unknown value" posture `packages/config` already takes for
  `.humanize.yml` ([`packages/config/src/index.ts:47`](../../packages/config/src/index.ts):
  a malformed/unrecognized document produces no configuration rather than a best-effort guess).
- `originMetadata.hostname`: hostname shape only; a value containing a path, query string, `@`, or
  credentials-shaped content is rejected outright, not truncated (truncating could silently keep a
  sensitive prefix).
- The whole payload: bounded overall size, checked before JSON parsing where possible (§11),
  mirroring the runner routes' pre-parse body-size limits ([`apps/api/src/runner.ts:26`](../../apps/api/src/runner.ts)
  `BODY_LIMIT`).

## 6. Character range semantics

**Chosen representation: zero-based, half-open, UTF-16 code-unit offsets into `text` — never into
the page.**

Reasoning:
- **UTF-16 over Unicode code points.** JavaScript strings (both in the extension and in any Node
  service) are natively indexed in UTF-16 code units — `slice`, `indexOf`, and `.length` all work
  this way. `docs/architecture/README.md` already commits the whole project to this convention for
  `ContentNode`/`SourceRange` ("zero-based UTF-16 half-open intervals"). Using the same unit for
  `BrowserText` avoids a second offset system and lets the same "did this quote actually occur at
  this offset" logic used elsewhere ([`packages/domain/src/index.ts:167`](../../packages/domain/src/index.ts)'s
  quote-containment checks) apply unchanged in spirit. The one thing this requires validating,
  which repository text mostly avoids by construction, is that a range boundary never lands inside
  a surrogate pair (an astral character such as most emoji occupies two UTF-16 units); `start`/`end`
  must each be a valid code-point boundary.
- **Relative to the submitted `text`, never relative to the page.** A page-relative offset would
  require knowing the DOM structure and live text content of the page at read time, which the
  server has no business holding — computing or storing it would mean capturing page structure
  beyond the user's selection, which is exactly the crawling/scraping behavior ADR-040 and §8 rule
  out. It would also be fragile: the same visible text can correspond to wildly different DOM
  offsets depending on markup, and a page can change between selection and response. Because the
  full `text` value the user selected is already available in its entirety to both the server and
  the extension, there is no need for either side to know where it sat in the page's DOM — the
  extension already holds its own reference to the original selection (e.g. its own `Range`
  object) and can re-locate a quoted substring inside *that* selection by ordinary string search,
  entirely client-side, with no page-structure information from the server at all.
- **No line numbers.** `ContentNode` carries `startLine`/`endLine` because GitHub review comments
  must attach to a specific line in a diff. `BrowserText` findings are not attached to a diff; the
  client already holds the complete `text` and can compute or display line/column information
  itself from a code-unit offset if a UI ever wants it. Carrying line numbers here would be
  unused ballast.
- **Newlines preserved verbatim.** `text` keeps its original newlines exactly as selected (no
  collapsing), matching `docs/architecture/README.md`'s "preserve original newlines" rule for
  repository content. Offset math therefore treats `\n` as one UTF-16 unit like any other
  character; a multi-line selection is not treated specially.
- **Normalization is a derived, non-authoritative operation.** `text` itself must never be
  Unicode-normalized or whitespace-collapsed before offsets are computed against it — doing so
  would silently invalidate any `characterRange` or later finding-range math (a form of the same
  bug class as the domain digest incident recorded in `docs/implementation/HANDOFF.md`, where two
  different serializations of the same value produced different results). If a normalized form is
  ever useful — for near-duplicate detection, hashing, or dedup, similar to
  `EphemeralContextIndex`'s trigram near-duplicate detection ([`packages/retrieval/src/index.ts`](../../packages/retrieval/src/index.ts)) —
  it must be computed as a separate derived value (e.g. via `normalizeText` from
  [`packages/shared/src/index.ts:57`](../../packages/shared/src/index.ts)), never used in place of
  the raw `text` for offset validation.

This design makes it possible for a future client to map a finding back to the exact highlighted
span within the text it already displayed, without the server ever needing to know anything about
the surrounding page.

## 7. Origin metadata

Kept deliberately minimal, and structured to make the "explicit selection, not a crawl" boundary
hard to cross by accident:

**Proposed to allow (optional, opt-in-gated for retention):**
- `hostname` — the site's hostname only (e.g. `docs.example.com`), never the full URL.
- `documentType` — a coarse content-type hint (`html`/`markdown`/`plaintext`), useful the way
  `ContentKind` is useful today, without describing the page's structure.
- `browserFamily` — a short, coarse client identifier for compatibility diagnostics only.

**Should NOT be collected by default, and are explicitly out of scope for this design:**
- **Full page URL** (path, query string, or fragment) — these routinely carry session tokens,
  document IDs, search terms, or other content-identifying or sensitive data that has nothing to
  do with the selected text.
- **Page title** — can itself disclose confidential document names or subjects independent of what
  the user chose to submit.
- **Surrounding DOM/HTML, sibling text, or any content beyond the exact selection** — collecting
  this would turn "the user explicitly submitted this text" into "Humanize inspected the page,"
  which is precisely the runtime crawling behavior the upstream specification and ADR-040 both
  exclude.
- **Cookies, full user-agent strings, IP-derived geolocation, or any other browser fingerprinting
  signal.**
- **Screenshots or clipboard contents beyond the selection.**

The guiding rule: origin metadata exists to make a future finding more *explainable and
diagnosable* (which kind of site, roughly what kind of document), never to reconstruct or infer
anything about the page the user did not explicitly hand over.

## 8. Privacy model

- **Ephemeral by default.** `text` and any origin metadata are processed for the single review
  request and discarded, not persisted, unless the user has explicitly opted into retention for
  that request or session. This mirrors the intent (not the mechanism) of the existing ephemeral
  retention mode, whose own rule is that content is "rebuilt per review and deleted after the job,
  not never written" (ADR-038); browser text should meet at least that bar, by default with no
  writing at all.
- **No unnecessary persistence.** Even the idempotency window for `requestId` (§4) should be the
  shortest interval that serves its purpose, not an indefinite log.
- **No provider secrets in the browser.** Unchanged from ADR-040/ADR-035: the extension never
  holds or transmits a model-provider API key; all provider calls happen server-side through the
  existing `@humanize/providers` adapters.
- **No unnecessary page content collection.** Enforced structurally by the field list in §4 and
  the explicit exclusions in §7 — there is no field anywhere in this design that could carry
  arbitrary page content beyond the user's selection.
- **No automatic crawling.** `BrowserText` only ever represents text a user explicitly selected
  and explicitly chose to submit; nothing in this contract describes or enables the extension
  fetching, scanning, or submitting content the user did not select.
- **No hidden/background submission.** Every `BrowserText` instance corresponds to one explicit,
  user-initiated action. This document does not design any automatic, periodic, or passive
  submission path, and none should be inferred from it.

## 9. Finding anchoring

The same non-negotiable rule that already governs repository review applies unchanged: **a
model-generated character range is never authoritative** (INV-014's principle, applied to a new
context). Concretely:

1. A reviewer/verifier response about `BrowserText` should be shaped the way `CandidateSchema`
   already is: it names the review category, an **`exactText` quote**, and an explanation — it
   does **not** supply offsets ([`packages/domain/src/index.ts:50`](../../packages/domain/src/index.ts)
   already avoids asking a model for coordinates at all, for exactly this reason).
2. The server independently validates that `exactText` literally occurs in the canonical, raw
   `text` value — the same technique `validateCandidate` already applies
   ([`packages/review/src/pipeline.ts:81`](../../packages/review/src/pipeline.ts):
   `if(!node.text.includes(candidate.exactText))`) and that `validateRunnerResult` applies again,
   independently, before anything is trusted (`CANDIDATE_TEXT_NOT_IN_NODE`,
   [`packages/domain/src/index.ts:192`](../../packages/domain/src/index.ts)). A quote that does not
   occur verbatim in `text` is suppressed, never published, exactly as today.
3. Only once a quote is confirmed to exist does the server derive a `characterRange` for the
   finding, deterministically, by locating that exact substring in `text` — the model is never the
   source of the number.
4. **Ambiguous matches.** Unlike a `ContentNode` (which is usually short and specific), a browser
   selection could plausibly contain the same short phrase more than once. A finding whose
   `exactText` is not unique within `text` should not silently anchor to an arbitrary occurrence.
   Proposed handling: prefer the first occurrence for display purposes, but treat non-uniqueness as
   a lower-confidence/flagged condition rather than a confident anchor — this needs a real decision
   once implementation is scoped (see Open questions), but "silently pick one" is explicitly not
   acceptable given how central precise highlighting is to the intended UI ("The phrase '...' may
   sound generic." with a precise highlighted range).
5. Because the extension already holds the complete, unmodified `text` it submitted, it can
   perform the same deterministic substring search itself to render the highlight — the server's
   derived `characterRange` is a convenience/consistency check, not something the client is unable
   to reproduce on its own.

This gives the intended UI — a quoted phrase with a precise highlighted range — without ever
trusting a model's idea of where something is.

## 10. Suggestions

**Automatic replacement is explicitly not designed here**, per ADR-040 and per this task's scope.
Findings for `BrowserText` should be **read-only**: category, severity, quoted `exactText`, and an
explanation. No replacement field, no apply action, no `SafeSuggestion`-equivalent.

Why the existing `SafeSuggestion` mechanism cannot simply be reused: `buildSuggestion`
([`packages/suggestions/src/index.ts:48`](../../packages/suggestions/src/index.ts)) proves a
replacement safe by **re-parsing the whole repository file** with `@humanize/extractors` after
applying the patch in memory, and asserting that parsing still succeeds, the node count is
unchanged, and *exactly one* node's text changed and nothing else about the file's structure did.
That proof depends entirely on there being a real, re-parseable source file with a known grammar
(JSX, Markdown, HTML, etc.) on the other end. Browser-selected text has no such file: it is an
arbitrary string lifted from an arbitrary, unknown DOM structure (a `contenteditable` region, a
CMS's rich-text field, a plain `<textarea>`, or plain page prose with no editable structure at
all). There is no parser to re-run, no file to structurally diff, and no way to prove that writing
a replacement back into the page would not corrupt surrounding markup, formatting, or an editor's
own internal state the way a raw text write into a JSX attribute could corrupt a component. Until
a browser-specific, page/editor-aware safety proof is designed — which is its own, separately
scoped and separately approved piece of work — findings must remain advisory text only, exactly as
ADR-040 already states.

## 11. API boundary

No endpoint is implemented by this document. The boundary is described only to make clear what
information should and should not cross each hop, for whoever eventually designs the real route.

```
Browser Extension
    ↓   requestId, schemaVersion, text, characterRange, sourceType,
    ↓   minimal originMetadata (hostname/documentType/browserFamily only), auth credential (TBD)
Browser Review API   (conceptual; not implemented)
    ↓   validated, size-bounded, schema-checked BrowserText value only —
    ↓   oversized or malformed input rejected here, before any downstream call
BrowserText
    ↓   text (fenced with a per-request boundary marker, as repository content already is —
    ↓   packages/review/src/pipeline.ts's boundaryMarker()), routed categories (derived
    ↓   server-side from sourceType/length, never from the model)
review infrastructure   (reuses rules()/reviewer/verifier ports conceptually, not GitHub-specific code)
    ↓   system prompt + fenced input only; no identity, no origin metadata, no session/request IDs
existing provider abstraction   (@humanize/providers, server-side only)
    ↓   category, severity, exactText quote, explanation, confidence — no offsets, no replacement
validated findings   (server derives characterRange per §9; never trusts a model-supplied one)
    ↓   findings array + the original requestId for correlation — no text is disclosed beyond an
    ↓   exactText quote the client already possesses in full
Extension
```

Two things are worth stating plainly about this diagram: **provider secrets never appear at any
step** (they live only inside the server-side provider adapters, as today), and **origin metadata
never crosses into the model-facing steps** — it may inform server-side routing decisions before
the model is called, exactly as `ContentNode.kind` does today, but it is not part of what the
reviewer or verifier ever reads.

## 12. Security considerations

- **Input validation**: every field in §4/§5 is schema-validated and fails closed on anything
  unrecognized (unknown `sourceType`, unknown `documentType`, malformed `hostname`, out-of-bounds
  `characterRange`, incompatible `schemaVersion`).
- **Maximum request size**: the whole payload should be bounded before parsing, the same way
  runner routes bound bodies before parsing them ([`apps/api/src/runner.ts:26`](../../apps/api/src/runner.ts)).
  Given `text` itself is capped (§4.1) and metadata fields are all short, a small, fixed overall
  cap (well under the runner's 8 KiB registration/heartbeat bodies, since this payload carries no
  cryptographic material) is appropriate; the exact number is an implementation detail for later,
  not fixed here.
- **Allowed metadata**: exactly the allow-list in §7 — hostname, documentType, browserFamily —
  and nothing else. Any field not on that list is not part of this contract.
- **Logging/redaction requirements**: `text`, `exactText`, any finding `explanation`, and
  `hostname` must never reach logs, traces, or telemetry dimensions in raw form — the same rule
  the existing telemetry surface already enforces for repository content, where "text",
  "explanation", "quote", and "replacement" are refused outright and even a bare file path is
  refused because "a path can identify private work" (`docs/implementation/HANDOFF.md`, S19-T01
  evidence). A hostname is lower-sensitivity than a file path but should be treated with the same
  posture by default until a specific, deliberate diagnostic need says otherwise.
- **Abuse considerations**: this is a new, comparatively open surface — any authenticated caller
  could submit review requests with no repository-enablement gate the way GitHub-path reviews have
  today. It must not be exposed without the authentication and rate-limiting dependencies below.
- **Authentication dependency**: this document assumes some `sessionIdentity` exists but does not
  design it — ADR-040 explicitly defers the extension authentication mechanism, and this document
  does not fill that gap.
- **Rate limiting dependency**: likewise assumed necessary, not designed. ADR-040's Abuse
  protection section and this document agree: no production exposure without it.

## 13. Explicit non-goals

- Does not implement `BrowserText` as a Zod schema or TypeScript type.
- Does not add an API route, package, or `apps/extension`.
- Does not modify `ContentNodeSchema`, `ReviewSnapshotSchema`, or any GitHub-path code.
- Does not design or implement authentication for the browser client.
- Does not design or implement rate limiting, quotas, or abuse enforcement.
- Does not design automatic suggestion/replacement — findings are read-only in this design.
- Does not design or enable page crawling, DOM scraping, or collection of any page content beyond
  an explicit user selection.
- Does not add a dependency or change any existing Phase 1 invariant.
- Does not change GitHub review behavior in any way.

## 14. Open questions

- Exact field names/types once this becomes a real schema, and which fields (if any) beyond
  `text` truly need to be required versus safely defaulted.
- The `sessionIdentity`/authentication mechanism itself (deferred by ADR-040; unresolved here too).
- Ambiguous-quote handling when `exactText` occurs more than once in `text` (§9): reject, flag
  low-confidence, or anchor to first occurrence — needs a real decision before implementation.
- The final numeric limits: max `text` length, max overall request size, idempotency-window
  duration — all placeholders here, not committed values.
- Whether `sourceType`/`documentType` should ever influence category routing the way `ContentKind`
  does today, or whether that adds complexity disproportionate to the initial (findings-only) MVP.
- Whether and how retention opt-in is expressed (a per-request flag? an account-level setting?)
  and what, precisely, gets stored if a user opts in.
- Whether a future browser suggestion safety model is even feasible for arbitrary, unstructured
  page content, or whether it should remain scoped to specific, deliberately supported editor
  integrations only.
- Rate limiting and quota mechanics in detail (still open from ADR-040).
- Whether the local Humanize Runner could ever serve a `BrowserText` request for users who want
  browser text kept off cloud providers (still open from ADR-040; this document does not add
  anything toward resolving it).
