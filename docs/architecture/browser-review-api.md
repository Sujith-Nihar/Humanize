# Browser Review API design

Status: design only. No route, schema, or authentication mechanism is implemented by this
document. It designs the HTTP boundary between a future browser extension and the existing
review/provider infrastructure precisely enough for a later, separately-scoped implementation
task to build safely — it does not authorize that task. Builds on [ADR-040](../adr/ADR-040.md)
and [browser-text.md](browser-text.md); nothing here reopens either.

## 1. Route family

**Proposed: `POST /extension/reviews`**, in a new, self-contained route module inside `apps/api`
(conceptually `apps/api/src/extension.ts`), registered from `createApi`
([`apps/api/src/app.ts`](../../apps/api/src/app.ts)) the same way `registerRunnerRoutes` and
`registerAdminRoutes` already are — an optional `options.extension?: ExtensionOptions` port,
composed in without changing the existing `webhookSecret`/`sink`/`runners`/`tokens`/`admin`
options.

- **Why it belongs in `apps/api`**: `docs/architecture/README.md` already defines `api` as the
  app that hosts "raw authenticated webhooks, tenant-authorized configuration, runner leases and
  control-plane publication" — i.e., every externally-authenticated actor talks to this one
  control-plane process. A browser extension is another externally-authenticated actor; it does
  not belong in `apps/worker` (queue-subscriber, no public HTTP surface) or `apps/runner`
  (outbound-only, never accepts inbound connections — see [`docs/architecture/runner.md`](runner.md)).
- **Separate from GitHub webhook routes**: `/webhooks/github` is unauthenticated-by-signature —
  trust comes entirely from HMAC verification of a GitHub-shaped raw payload
  ([`apps/api/src/app.ts:25`](../../apps/api/src/app.ts)). `/extension/*` trust comes from a
  caller-presented credential over ordinary JSON; the two have nothing in common except living in
  the same process, and mixing them into one module would blur two different trust boundaries the
  way `check-boundaries.mjs` already polices at the package level.
- **Separate from runner routes**: `/runner/*` represents a pre-registered, leased runner
  *process* executing a fenced GitHub job under `RunnerService`
  ([`apps/api/src/runner.ts:6`](../../apps/api/src/runner.ts)) — its whole vocabulary (lease,
  fence, `leaseScope`, job-scoped GitHub token) is meaningless for a one-shot, ad hoc browser
  review with no lease and no repository. Registering extension routes inside `registerRunnerRoutes`
  would force runner authentication/authorization logic to also branch for a completely different
  actor type, which is exactly the kind of scope creep `apps/api`'s existing modules avoid today
  (each of `runner.ts`/`admin.ts`/`app.ts` owns exactly one actor's protocol).
- **Own module**: yes. A `registerExtensionRoutes(app, service: ExtensionReviewService,
  authenticator: ExtensionAuthenticator)` function, structurally parallel to
  `registerRunnerRoutes(app, service, issuer, publication?)` and `registerAdminRoutes(app,
  options)`, keeps `app.ts` a thin composition root (as it is today — it does no validation or
  business logic itself) and keeps the browser actor's request/response shapes, error codes, and
  auth check entirely out of the other two modules' files.

`/extension/reviews` (plural, collection-style, matching the REST shape already used for
`/api/repositories` and `/api/credentials`) is preferred over a verb-shaped path; each `POST`
creates one review result for one submitted `BrowserText`. Whether a companion `GET
/extension/reviews/:requestId` is ever needed for asynchronous polling is an open question (§10,
§14) tied to latency, not decided here.

## 2. Request contract

Built directly from [browser-text.md](browser-text.md)'s field design, kept intentionally minimal
— **only what review requires crosses the wire**:

| Field | Required | Notes |
|---|---|---|
| `schemaVersion` | required | literal, e.g. `'humanize-browsertext-v1'`; checked first, before any other field, mirroring the runner routes' `incompatible()` pre-check ([`apps/api/src/runner.ts:41`](../../apps/api/src/runner.ts)) |
| `requestId` | required | client-generated UUID; used for idempotency (a retried identical submission returns the same result rather than reviewing twice — the same intent as webhook delivery dedup, INV-009, though the concrete mechanism is undesigned) and for response correlation |
| `text` | required | the selected text; bounded (see below) |
| `characterRange` | optional | `{start, end}`, UTF-16 half-open, relative to `text`; defaults to `{0, text.length}` when the whole submitted `text` **is** the selection, which is expected to be the common case |
| `sourceType` | required | closed enum per browser-text.md §4 |
| `originMetadata` | optional | `{hostname?, documentType?, browserFamily?}` only — no other sub-fields, per browser-text.md §7's allow-list |
| `language` | optional, default `'en'` | the only review-option field proposed for v1, matching the existing initial English-only gate (`ReviewSnapshot.language`/`allowUnevaluatedLanguage`, [`packages/domain/src/index.ts:79`](../../packages/domain/src/index.ts)) |

**Deliberately not included** (the instruction to "not invent unnecessary fields" is taken
literally): no provider/model selection (an administrator/server concern, INV-007 — never
caller-selectable), no category or terminology overrides (that is per-repository configuration
territory owned by `.humanize.yml`/organization policy, which has no meaning for an ad hoc
personal review), no severity threshold override, no `sessionIdentity` field in the body (identity
comes from the `Authorization` header via the pluggable authenticator, §5 — duplicating it in the
body would create two sources of truth for who is asking).

**Sizes** (concrete starting proposals, explicitly placeholders pending real tuning, consistent
with browser-text.md's own "placeholder, not final" framing):
- `text`: capped at **2,000 UTF-16 code units** for the API's first version — smaller than
  `ContentNode`'s 10,000-unit cap ([`packages/domain/src/index.ts:111`](../../packages/domain/src/index.ts))
  because a highlighted browser selection is realistically a sentence to a short paragraph, and a
  large cap disproportionately increases both provider cost and abuse surface for a
  publicly-reachable, ad hoc endpoint.
- Whole request body: capped at **32 KiB**, enforced by Fastify's per-route `bodyLimit` *before*
  parsing, the same pre-parse-rejection pattern the runner routes already use
  ([`apps/api/src/runner.ts:26`](../../apps/api/src/runner.ts) `BODY_LIMIT`/`RESULT_LIMIT`). This
  comfortably covers 2,000 UTF-16 units of worst-case 4-byte UTF-8 text plus the small metadata
  fields, with headroom, while staying far below the runner result route's 8 MiB (which carries
  full `ContentNode`s and evidence — this route carries neither).

## 3. Response contract

**`ValidatedFinding` should not be reused directly; a browser-specific response DTO is safer.**
`ValidatedFinding` ([`packages/domain/src/index.ts:64`](../../packages/domain/src/index.ts))
carries `node: ContentNode` (full repository/commit/blob/file identity — meaningless and
unavailable for browser text, and exactly the kind of fabricated-identity problem
[browser-text.md](browser-text.md) rules out), `evidenceRecords: EvidenceRecord[]` (each of which
carries `revision`/`contentHash` fields that assume a repository blob — see §6), a `fingerprint`
and `deterministic`/`blocking`/`verificationConfidence` (internal correctness-proof bookkeeping,
not client-facing information), and an optional `suggestion: SafeSuggestion` (not offered here at
all, §10 of [ADR-040](../adr/ADR-040.md)). Serializing it as-is would either leak internal
plumbing or force fabricating the very fields this whole design exists to avoid fabricating.
Instead, the server projects a small, purpose-built view:

```
BrowserReviewResponse {
  requestId: string            // echoes the request, for client correlation
  schemaVersion: string        // same literal as the request
  findings: BrowserFinding[]
}
BrowserFinding {
  category: Category           // reused verbatim from @humanize/domain's existing enum
  severity: Severity            // reused verbatim
  exactText: string             // the quoted substring, verified to occur in the submitted text (§7)
  range: { start: number, end: number }   // server-derived, never model-supplied (§7)
  explanation: string
  confidence?: number           // optional; non-sensitive, informational only
}
```

`category`/`severity` are reused directly from `@humanize/domain`'s existing `Category`/`Severity`
enums (no reason to invent parallel vocabulary the client would have to learn separately) —
**only the envelope is new**, not the finding vocabulary.

**Explicitly not exposed**: provider name or model identifier (an internal implementation detail
with no value to the end user and a mild information-leak surface about which vendor is in use —
if ever needed for debugging, it belongs in server-side telemetry's already-allowlisted
`provider`/`model` dimensions, not the client response), `node`/`fingerprint`/`evidenceRecords`,
`replacement`/`suggestion` (read-only per §10 below), internal diagnostics counts, raw provider
errors, stack traces, or any secret/credential material.

## 4. Error contract

A fixed, stable set of API-level error codes, mapped the same way the runner routes already map a
small `REPORTABLE` set of known causes to specific statuses and fall back to a generic,
non-leaking failure for everything else ([`apps/api/src/runner.ts:32`](../../apps/api/src/runner.ts)):

| Code | HTTP status | Retryable | Meaning |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | no (fix and resend) | schema validation failed |
| `SCHEMA_VERSION_UNSUPPORTED` | 409 | no (client update required) | mirrors `INCOMPATIBLE_PROTOCOL` |
| `TEXT_TOO_LARGE` | 413 | no (shorten text) | body or `text` exceeded its bound |
| `INVALID_CHARACTER_RANGE` | 400 | no | `characterRange` out of bounds or splits a surrogate pair |
| `UNAUTHENTICATED` | 401 | no (fix credential) | missing/invalid/expired credential |
| `RATE_LIMITED` | 429 | yes, after `Retry-After` | abuse-control limit hit |
| `PROVIDER_UNAVAILABLE` | 503 | yes, bounded backoff | upstream model call failed transiently (maps `ProviderError` codes `TRANSPORT`/`RATE_LIMIT`/`TIMEOUT`/`MODEL_UNAVAILABLE`) |
| `REVIEW_FAILED` | 502 | yes, bounded backoff | the review completed the request but could not produce a result (e.g. malformed model output survived repair) |
| `INTERNAL_ERROR` | 500 | no (default) | generic catch-all; no message ever echoed, matching today's `app.ts` handler |

**Ambiguous finding anchoring is deliberately not a request-level error.** It is a per-finding
outcome: a candidate whose `exactText` is not uniquely located in the submitted text is suppressed
from the response (never guessed at — §7), the same way `reviewNodes` already suppresses
individual candidates today (`SuppressionReason`,
[`packages/review/src/pipeline.ts:8`](../../packages/review/src/pipeline.ts)) without failing the
whole review. A whole request never fails because one candidate among several was ambiguous.

**Never exposed to the caller**: a `ProviderError`'s internal code beyond the coarse
retryable/non-retryable mapping above (`AUTH`/`PERMISSION`/`UNSUPPORTED_CAPABILITY`/`INVALID_OUTPUT`/
`CONTEXT_LIMIT`/`REFUSAL`/`CANCELLED` all collapse to `INTERNAL_ERROR` rather than revealing which
one occurred, since several of these hint at server-side provider configuration problems an
external caller has no legitimate need to see), raw exception messages, or stack traces — matching
the existing rule that a runner-facing 503 "does not leak a connection string"
([`apps/api/runner.test.ts:78`](../../apps/api/runner.test.ts)).

## 5. Authentication boundary

Authentication is **not chosen or implemented here**, per ADR-040. What is designed is the
boundary that makes it pluggable: `registerExtensionRoutes` takes an injected
`ExtensionAuthenticator` port (conceptually `authenticate(request): Promise<ExtensionIdentity |
null>`), exactly the way `admin.ts` takes an injected `IdentityProvider` "so the exchange is
testable without credentials" and `runner.ts` takes an injected `RunnerService`/`TokenIssuer` so
`apps/api` "holds no persistence logic." The route handler only ever calls this port; it contains
no concrete auth mechanism itself, so a mechanism can be designed and swapped later without
touching route, validation, or review-invocation code.

**What identity the API will eventually need**: something stable enough to rate-limit and quota
per caller, individually revocable, and *not* scoped the way either existing credential is scoped.

- **Runner bearer credentials must not be accepted here.** They authorize one specific, enrolled
  runner *process* to execute leased, tenant/repository-scoped GitHub jobs under the fencing
  protocol (`RunnerService.leaseScope`/`claim`/`renew`,
  [`docs/architecture/runner.md`](runner.md)). Accepting them for browser requests would let a
  credential minted for "execute this leased GitHub job" be replayed for an unrelated purpose
  ("review arbitrary text on demand"), which breaks the least-privilege scoping the lease protocol
  exists to enforce and enlarges the blast radius of a single compromised runner credential well
  beyond its intended job-execution role.
- **Dashboard session cookies should not become the extension credential.** `SessionSigner`
  ([`packages/security/src/index.ts:35`](../../packages/security/src/index.ts)) issues an
  HttpOnly, `SameSite=Lax` cookie bound to the dashboard's own same-origin OAuth flow, carrying
  organization-membership claims meant for administrative actions (managing credentials,
  repositories, policy). An extension's background/service-worker context does not naturally share
  that cookie jar, the session's 12-hour TTL and revocation semantics are tuned for interactive
  admin sessions rather than a long-lived, high-volume extension install, and conflating a
  high-privilege administrative credential with a comparatively low-trust, high-volume, per-request
  credential increases the damage a compromised browser or extension host page could do.
- The concrete mechanism (a personal access token issued through the existing dashboard session, a
  device-authorization flow, an anonymous/device-bound token) remains an open question (§14),
  unchanged from ADR-040 and browser-text.md.

## 6. Review integration

**Correction to an earlier version of this document.** A previous draft of this section proposed
that `BrowserText` call `ModelProvider.generateStructured` directly and separately reproduce
prompt fencing, quote-containment validation, and verifier separation in a new, browser-specific
function outside `packages/review`. **That is rejected.** It would create a second, independently
maintained implementation of the exact model-invocation and validation logic the GitHub path
already has, with no mechanism to keep the two in sync — precisely the "second independent review
engine" ADR-040 already ruled out as an alternative (its Alternative 4). This section replaces that
proposal with the intended architecture: a single **common review core**, shared by both the
GitHub path and the browser path, with each path supplying its own anchoring and mapping around
that shared core.

```
GitHub ContentNode ──┐
                      ├──> Common Review Core ──> Provider abstraction
BrowserText ──────────┘         │
                                 ▼
                        Validation / verification
                                 │
                        surface-specific DTO
     (ValidatedFinding+node,                 (BrowserFinding+range)
      SafeSuggestion — GitHub only)
```

### 6.1 What the existing code actually supports today

**Does a clean common core exist today, ready to call from both paths? No.** The ingredients for
one exist and are demonstrably generic in *behavior*, but they are not exposed as a standalone
unit independent of `ContentNode`/`ReviewSnapshot` — every generic mechanism below is currently
reached only by going through a function whose *parameter type* is `ContentNode` or
`ReviewSnapshot`. That is the concrete, code-level basis for the conclusion in §6.2.

**A. Truly generic — supported by the existing source, in behavior, but not in current signatures:**

- The `ModelProvider`/`generateStructured` contract and its schema-validation, retry, repair and
  timeout mechanics ([`packages/providers/src/base.ts:26`](../../packages/providers/src/base.ts))
  — already provider-agnostic and content-agnostic; nothing here reads a `ContentNode` field at
  all.
- `ReviewerResponseSchema`/`VerificationSchema`/`CandidateSchema`
  ([`packages/domain/src/index.ts:50`](../../packages/domain/src/index.ts)) — model-output
  validation is already source-agnostic; none of these schemas contains a repository field.
- `fence()` ([`packages/review/src/prompt.ts:9`](../../packages/review/src/prompt.ts)) — pure
  string wrapping/marker-stripping, reads nothing but the marker and the body text handed to it.
- The quote-containment check — `node.text.includes(candidate.exactText)` inside `validateCandidate`
  ([`packages/review/src/pipeline.ts:81`](../../packages/review/src/pipeline.ts)) and the
  equivalent in `validateRunnerResult`
  ([`packages/domain/src/index.ts:192`](../../packages/domain/src/index.ts)) — the *logic* needs
  only an id and a text string; it happens to be written against `ContentNode`/`RunnerResult`
  today, but reads only `.id` and `.text`.
- The two-invocation reviewer/verifier separation, and the `authorFacing`/`placeholdersOf` checks
  on verifier corrections ([`packages/review/src/pipeline.ts:31`](../../packages/review/src/pipeline.ts)–`43`)
  — pure string/regex logic over the candidate's own text fields, reads no repository state.
- `validateCandidate`'s category-routing and evidence-reference checks
  ([`packages/review/src/pipeline.ts:79`](../../packages/review/src/pipeline.ts)) — reads only
  `node.id`, `node.text`, a routed category list, and an evidence-id map.
- Common finding vocabulary — `Category`, `Severity`, `SuppressionReason` — pure enums/unions, no
  repository dependency.

  **The caveat that matters**: `reviewerInput`/`verifierInput`
  ([`packages/review/src/prompt.ts:42`](../../packages/review/src/prompt.ts)) and
  `validateCandidate` all declare their parameter as `node: ContentNode`, and `reviewerInput` also
  renders one genuinely repository-specific line into the prompt — `` `Content kind: ${node.kind}.
  Source: ${node.filePath}.` `` ([`packages/review/src/prompt.ts:48`](../../packages/review/src/prompt.ts))
  — mixing a generic fact (`kind`) with a repository-specific one (`filePath`) in one string. So
  even the parts of the prompt that are conceptually generic are not cleanly separated from the
  repository-specific parts *within the same function* today.

**B. Repository-specific — supported by the existing source:**

- `ReviewSnapshot` and its GitHub-installation/PR/commit fields
  ([`packages/domain/src/index.ts:74`](../../packages/domain/src/index.ts)), and the
  `NODE_OUT_OF_SNAPSHOT` check that opens every iteration of `reviewNodes`
  ([`packages/review/src/pipeline.ts:106`](../../packages/review/src/pipeline.ts)).
- `ContentNode` identity fields (`repositoryId`, `commitSha`, `blobSha`, `filePath`, `parser`/`parserVersion`,
  `stableKey`).
- `evaluateRules`'s evidence construction — the `signal()` helper
  ([`packages/rules/src/index.ts:146`](../../packages/rules/src/index.ts)) unconditionally builds
  every `EvidenceRecord` from `node.filePath`, `node.startLine`, `node.commitSha`, and
  `node.blobSha`. This is despite the fact that the actual pattern detection above it (the
  `PROMOTIONAL`/`PADDING`/`CONSTRUCTIONS` regex scans, [`packages/rules/src/index.ts:167`](../../packages/rules/src/index.ts)ff.)
  reads only `node.text` and is, in isolation, pure string matching. **Detection and evidence
  construction are fused into one exported function**, and only the latter is repository-specific
  — see §6.3.
- `routeNode`'s and `EphemeralContextIndex`/`buildContext`'s `ContentNode`-typed signatures and the
  same-file/near-duplicate retrieval `buildContext` performs, which is inherently about other
  content in the same repository/commit.
- `SafeSuggestion` and `buildSuggestion`'s file-re-parse structural proof
  ([`packages/suggestions/src/index.ts:48`](../../packages/suggestions/src/index.ts)) — already
  established as non-reusable for browser text (§10 of [ADR-040](../adr/ADR-040.md)).
- `ValidatedFinding.node: ContentNode`
  ([`packages/domain/src/index.ts:64`](../../packages/domain/src/index.ts)) — the *existing*
  "validated finding" output type is itself repository-shaped, because it embeds the whole node.

**C. Browser-specific — proposed by this design, not existing code:**

- `BrowserText` and its fields ([browser-text.md](browser-text.md)).
- UTF-16 range *derivation* by deterministic substring search against `BrowserText.text` (§7) —
  there is no file and no `segments` decoding step the way `ContentNode` has.
- The ambiguous-`exactText` suppression policy (§7) — never guess a match.
- The `BrowserReviewResponse`/`BrowserFinding` DTO and its projection out of whatever the common
  core returns (§3).

### 6.2 Conclusion: a refactor is required before implementation

**A clean common review core does not exist today.** The generic ingredients in §6.1.A are real,
but they are reachable today only through functions typed against `ContentNode`/`ReviewSnapshot`,
and one of the two ports `reviewNodes` depends on (`rules()`, via `evaluateRules`) fuses generic
detection with repository-specific evidence construction inside one function. Building `BrowserText`
review today, without addressing this, has exactly two paths, and both are unacceptable:

1. Fabricate repository identity to satisfy `ContentNode`/`ReviewSnapshot` and call the existing
   functions unmodified — forbidden by [ADR-040](../adr/ADR-040.md) and
   [browser-text.md](browser-text.md).
2. Reproduce the generic logic independently for browser text — the rejected "second review
   engine" this revision removes.

**The correct order of work is therefore: first extract a narrow common review service from the
existing pipeline; then implement `BrowserText` on top of it. Step 1 below is now done** — a
first, deliberately narrow implementation pass — recorded here as the minimum correction this
document needs; steps 2–3 remain a separately-scoped, separately-approved implementation task.

1. **Done.** [`packages/review/src/core.ts`](../../packages/review/src/core.ts) defines
   `ReviewableUnit` (`{id: string; text: string; placeholders: readonly string[]}`) and exports
   two extracted, source-agnostic functions: `validateCandidate` (the quote-containment/category/
   evidence gate) and `applyVerification` (the verifier-correction revalidation — placeholder
   preservation and the author-facing check). `reviewerInput`/`verifierInput`
   ([`packages/review/src/prompt.ts`](../../packages/review/src/prompt.ts)) now take a
   `ReviewableUnit` instead of a `ContentNode`; `reviewerInput` also takes an optional
   `contextLabel` string, and `reviewNodes`
   ([`packages/review/src/pipeline.ts`](../../packages/review/src/pipeline.ts)) computes the
   repository-specific `` `Content kind: ${node.kind}. Source: ${node.filePath}.` `` line itself and
   passes it in, exactly as this document predicted. `ContentNode` and `ReviewSnapshot` are
   unchanged, and `reviewNodes`'s observable behavior is unchanged — the full existing test suite
   passes unmodified except for one external test call site
   ([`evals/security/boundaries.test.ts`](../../evals/security/boundaries.test.ts)) updated
   mechanically for the renamed parameter.

   **Correction to this document's original prediction**: step 2 below originally proposed
   extracting the *entire* reviewer-call → validate → verifier-call → revalidate sequence into one
   orchestrating function. On inspection, the reviewer/verifier `generateStructured` calls
   themselves were already source-agnostic port calls with no `ContentNode` coupling to remove;
   the only logic actually fused to `ContentNode` was the validation and verification-correction
   steps now in `core.ts`. Extracting a single monolithic orchestrator would have meant
   restructuring `reviewNodes`'s control flow (its early `continue`s, its `try`/`catch` scope, and
   the repository-specific `evidence` map threaded through both model calls) for no additional
   decoupling benefit, which is more change than the evidence justified. The narrower extraction
   below was made instead.
2. **Not yet done, and now understood to be smaller than originally scoped.** A `BrowserText`
   caller does not need a new single "core-finding" function. It needs its own thin loop —
   analogous to `reviewNodes`'s, but with no `ReviewSnapshot` and no `NODE_OUT_OF_SNAPSHOT` check —
   that builds a `ReviewableUnit` from `BrowserText`, calls `ports.reviewer.generateStructured`
   directly with `reviewerInput({unit, ...})`, calls `validateCandidate` per candidate, calls
   `ports.verifier.generateStructured` with `verifierInput({unit, ...})`, and calls
   `applyVerification` per verdict — reusing exactly the functions and schemas the GitHub path
   uses, with no browser-specific copy of any of them.
3. A browser-side caller maps the resulting candidate/verdict pairs into `BrowserFinding` by
   deriving `range` (§7) instead of attaching a `ContentNode` — this mapping step is unchanged from
   the original prediction.
4. **Deterministic rules stay out of this extraction, deliberately** — see §6.3, unchanged.

Step 1 removes the schema-fabrication and logic-duplication objections for the validation/
verification-correction logic. What remains before `BrowserText` review can be implemented is
scoped implementation work (step 2's loop, `BrowserText` itself, the API surface, and
authentication), not further pipeline extraction.

### 6.3 Deterministic rules remain repository-only

Revisiting the previous version's open question — **resolved, not left open**: deterministic
rule-based findings (`evaluateRules`) should **not** extend to browser text at this stage. The rule
*matching* logic (the regex scans in [`packages/rules/src/index.ts`](../../packages/rules/src/index.ts))
is pure string matching over `node.text` and is plausibly source-agnostic in isolation, but the
exported `evaluateRules` function is not: every detected signal is wrapped by `signal()`
([`packages/rules/src/index.ts:146`](../../packages/rules/src/index.ts)) into an `EvidenceRecord`
that unconditionally reads `node.filePath`/`node.startLine`/`node.commitSha`/`node.blobSha`. **The
existing rule abstraction is not demonstrably source-agnostic today** — detection and
repository-evidence construction are fused in one function, and separating them (a real, if
small, refactor of `packages/rules`) is itself out of scope for this design. Per the explicit
instruction not to expand scope unnecessarily: deterministic rules remain a GitHub/repository-only
feature until and unless that separation is done as its own, separately-scoped task. `BrowserText`
review, when implemented, uses the reviewer/verifier model path only (§6.2), with no deterministic
standalone findings.

## 7. Finding anchoring

```
BrowserText.text
    ↓
common review core (§6): reviewer/verifier via ModelProvider, same schemas the GitHub
path uses — one implementation, not a browser-specific copy
    ↓  candidate.exactText  (a quoted substring — never an offset; CandidateSchema already
    ↓                        asks for a quote, not coordinates, for exactly this reason)
server validates: does BrowserText.text include candidate.exactText verbatim?
    ↓  no  → suppressed, never published (mirrors validateCandidate/validateRunnerResult's
    ↓         quote-containment checks, packages/review/src/pipeline.ts:81, packages/domain/src/index.ts:192)
    ↓  yes
server locates the match deterministically (string search over the canonical, raw text)
    ↓
    ├─ unique match  → range = {start, end} derived from that match; UTF-16 half-open (§6 of browser-text.md)
    └─ non-unique match (exactText occurs more than once)
            → the finding is suppressed, not published with a guessed range —
              this is the explicit "do not silently choose a match" requirement
    ↓
validated BrowserFinding { category, severity, exactText, range, explanation }
    ↓
response
```

This is the same non-negotiable rule already governing GitHub review — a model never supplies an
authoritative coordinate (INV-014) — applied to a context with no file to re-derive coordinates
from, so the *only* source of truth is the submitted `text` string itself, checked by exact,
deterministic substring containment and located by exact, deterministic substring search, never by
trusting anything the model says about position.

## 8. Privacy and logging

The submitted `text`, any `exactText` quote, and any `explanation` **must never** become a value in
a standard log line, an error log, a telemetry `log()`/`measure()` call, a trace span attribute, a
metric label, or a provider error message. Concretely, against the existing telemetry surface
([`packages/telemetry/src/index.ts`](../../packages/telemetry/src/index.ts)):

- The `allowed` field set (`event`, `traceId`, `runId`, `organizationId`, `repositoryId`,
  `runnerId`, `provider`, `model`, `role`, `durationMs`, `count`, `errorClass`, `state`, `attempt`,
  `coverage`, `status`) would need `requestId` added for this route's tracing — and **nothing
  else**. `text`, `exactText`, `explanation`, and `originMetadata.hostname` must never be added to
  this allowlist, for the same reason a bare file path is refused today: "a path can identify
  private work," and browser text is, by design, potentially more sensitive than a repository path
  (§8 of [browser-text.md](browser-text.md)).
- `scrub()`'s `CREDENTIAL_SHAPES` regex backstop (catching bearer tokens, provider keys, long
  opaque tokens wherever they appear) still applies, but it is a backstop for the *unexpected*
  case, never a substitute for keeping `text`/`exactText`/`explanation` out of logged fields in the
  first place — an arbitrary short secret or an ordinary sentence of prose is not something shape-based
  scrubbing can distinguish, which is an already-recorded limit of that mechanism.
- Route-level error handling must reduce any caught error (a `ProviderError`, a Zod validation
  failure, an unexpected exception) to one of the fixed codes in §4 *before* logging anything about
  it — never log the raw `Error.message` from a failure path that could have originated from model
  output containing the reviewed text (e.g. a provider's own error response quoting back part of
  the request).
- No field derived from `text` should ever appear in a trace span's attributes or a metric's
  dimensions; only counts, durations, and the fixed error/finding codes should.

## 9. Request lifecycle

1. **Receive request** — `POST /extension/reviews`, JSON body, size-limited pre-parse (§2).
2. **Authenticate** — the injected `ExtensionAuthenticator` port resolves an identity or the
   request is refused with `UNAUTHENTICATED` before anything else runs (§5).
3. **Validate request** — schema-check the body (§2); `SCHEMA_VERSION_UNSUPPORTED` and
   `INVALID_REQUEST` are both decided here, before the authenticator's identity is used for
   anything beyond the check already performed in step 2.
4. **Enforce size limits** — `text` length and total body size against the bounds in §2;
   `TEXT_TOO_LARGE` here.
5. **Construct `BrowserText`** — assemble the validated, canonical in-memory value; this is the
   only place the conceptual type from [browser-text.md](browser-text.md) is materialized.
6. **Invoke review** — a `ReviewableUnit` built from `BrowserText` is passed through the same
   `validateCandidate`/`applyVerification` functions and `reviewerInput`/`verifierInput` prompt
   builders the GitHub path uses (§6.2, step 1, done), inside a browser-specific loop analogous to
   `reviewNodes`'s (§6.2, step 2, not yet built) that calls the reviewer and verifier ports
   directly — no `ReviewSnapshot`, no `ContentNode`.
7. **Validate findings** — the exact-quote containment check (§7); anything that fails is dropped,
   not surfaced as an error.
8. **Derive ranges** — deterministic substring search against the canonical `text` for each
   surviving candidate; ambiguous matches dropped, not guessed (§7).
9. **Return response** — the `BrowserReviewResponse` DTO (§3), never the internal
   `ValidatedFinding`.
10. **Discard ephemeral browser text** — by construction, not by an explicit deletion step: `text`
    and every derived value live only in the request's in-memory scope and are never written to a
    store, queue, or log; once the response is sent, nothing referencing the submitted content
    remains, consistent with the ephemeral-by-default privacy model (§8 of
    [browser-text.md](browser-text.md)). No persistence path is designed or implied by this
    lifecycle.

## 10. Abuse controls

Requirements only — none implemented:

- **Authentication**: mandatory before any review runs (§5); the route must have no
  unauthenticated code path that reaches the provider abstraction.
- **Rate limiting**: per authenticated identity at minimum; per-IP as defense in depth against a
  compromised or shared identity. Mechanism undesigned.
- **Quotas**: a longer-window cap (e.g. daily/monthly request count) per identity, independent of
  short-window rate limiting, to bound aggregate provider cost from one caller.
- **Request-size limits**: fixed in §2 (2,000 UTF-16 units of text, 32 KiB total body) —
  placeholders pending real tuning, not final numbers.
- **Concurrency limits**: a cap on simultaneous in-flight reviews per identity, so one caller
  cannot hold open an unbounded number of expensive model calls at once.
- **Provider cost protection**: a hard per-request ceiling on the number of model calls (the
  reviewer/verifier pair only — no retries beyond what `JsonProvider` already bounds internally,
  [`packages/providers/src/base.ts:48`](../../packages/providers/src/base.ts)), and consideration
  of a smaller/cheaper default model tier for this route distinct from whatever an organization has
  configured for its GitHub-path reviewer/verifier (open question, §14).
- **Timeout limits**: the existing global Fastify `requestTimeout: 30000` in
  [`apps/api/src/app.ts:11`](../../apps/api/src/app.ts) may not be sufficient for a synchronous
  reviewer-then-verifier round trip, particularly against Ollama (whose provider adapter already
  uses a 180-second internal deadline, [`packages/providers/src/base.ts:29`](../../packages/providers/src/base.ts)).
  Whether this route needs a longer, route-specific timeout or should instead be asynchronous
  (submit now, poll or receive results later) is an open question (§14), not decided here.

## 11. Browser client expectations

A future extension should assume, and this API should be designed to guarantee:

- **HTTPS only** — no plaintext transport.
- **JSON request/response** — matching every other route in `apps/api` today.
- **No provider credentials ever held by the extension** — every model call happens server-side.
- **No direct LLM calls from the extension** — all review goes through this API.
- **No hidden submission** — every request corresponds to one explicit user action; the API has no
  concept of, and should never be extended to have, a background/periodic submission mode.
- **Explicit user action required** for every request — consistent with the ADR-040/browser-text.md
  privacy stance.
- **`requestId` for correlation** — the client generates and can rely on it being echoed back
  unchanged, for retry/idempotency and for matching a response to the request that produced it.
- **Findings-only behavior** — no replacement text, no apply action, no automatic page
  modification; the client renders `explanation`/`category`/`severity` and highlights `range`
  against the exact text it already has, and nothing more.

## 12. Explicit non-goals

- No replacement for GitHub PR review — the existing pipeline is untouched and remains the
  authoritative Humanize product surface for repository content.
- No page crawling or DOM scraping — this API only ever receives text the user explicitly selected
  and the extension explicitly submitted.
- No automatic submission of page content — every request is one explicit user action (§11).
- No automatic text replacement — findings are read-only (§3, §10 of ADR-040).
- No provider calls from the browser — all model access is server-side only.
- No runner credential reuse — a dedicated, separate identity is required (§5).
- No persistent storage by default — ephemeral processing only (§9).
- No silent local-to-cloud fallback — INV-007 applies unchanged; whatever model tier this route
  uses is a deliberate, explicit server-side configuration choice, never a silent substitution.
- No AI-authorship detection claim — INV-006 applies unchanged; a `BrowserFinding`'s `explanation`
  describes an observable writing pattern, exactly as a GitHub-path finding does today, never a
  claim about who or what wrote the text.

## 13. Testing strategy

Conceptual test cases only, in the style already used in `apps/api/runner.test.ts` (Fastify
`app.inject`, asserting status code, response shape, and that a mock port was or was not called —
never asserting on internal implementation details):

| Case | Expectation |
|---|---|
| Valid request | 200/201, `BrowserReviewResponse` shape, `requestId` echoed |
| Malformed request (missing `text`/`schemaVersion`, wrong types, extra unknown fields on a strict schema) | 400 `INVALID_REQUEST`; authenticator/review port never invoked beyond what's needed to reject |
| Oversized text | 413 `TEXT_TOO_LARGE`; provider never called (cost-protection proof, mirroring the runner route's oversized-body test at [`apps/api/runner.test.ts:87`](../../apps/api/runner.test.ts)) |
| Invalid UTF-16 range (out of bounds, `start > end`, splits a surrogate pair) | 400 `INVALID_CHARACTER_RANGE` |
| Unsupported schema version | 409 `SCHEMA_VERSION_UNSUPPORTED`, before authentication or review runs — mirroring the runner routes' `INCOMPATIBLE_PROTOCOL` test at [`apps/api/runner.test.ts:30`](../../apps/api/runner.test.ts) |
| Missing authentication | 401 `UNAUTHENTICATED`; review port never invoked (asserted not-called, exactly like `register`/`heartbeat` in the existing runner tests) |
| Rate limit exceeded | 429 `RATE_LIMITED` with `Retry-After`; provider never called |
| Provider failure (`ProviderError` TRANSPORT/RATE_LIMIT/TIMEOUT) | 503 `PROVIDER_UNAVAILABLE`; response body contains no provider-specific detail (mirroring the "does not leak a connection string" assertion at [`apps/api/runner.test.ts:78`](../../apps/api/runner.test.ts)) |
| Malformed provider output (fails schema even after repair) | mapped to `PROVIDER_UNAVAILABLE` or `REVIEW_FAILED`, never a fabricated finding |
| `exactText` not present in submitted text | that candidate silently suppressed from the response (not an error); asserted via an empty or reduced `findings` array, not a thrown exception |
| Duplicate/ambiguous `exactText` | finding suppressed, not returned with a guessed range — this is the direct test of the §7 "do not silently choose a match" rule |
| Successful finding response | exact shape assertion: `category`/`severity`/`exactText`/`range`/`explanation` present; `node`/`fingerprint`/`evidenceRecords`/provider/model fields **absent** |
| Sensitive-text logging regression | submit `text` containing a credential-shaped or otherwise sensitive marker string; capture whatever the app logs/emits as telemetry during the request; assert the marker never appears anywhere in captured output — the same regression shape as the existing telemetry redaction tests ([`packages/telemetry/redaction.test.ts`](../../packages/telemetry/redaction.test.ts)) and the connection-string non-leak test in `runner.test.ts`, but exercised against a route whose entire payload, unlike every existing route, is freeform prose |

## 14. Open questions

Carried forward from [browser-text.md](browser-text.md) where unresolved there, plus new ones this
step surfaced. Note: "whether deterministic rule-based findings should ever extend to browser
text" — raised as open in the previous revision of this document — is **no longer open**; §6.3
resolves it: no, not unless and until `packages/rules`' detection and evidence-construction are
separated as their own task, which is out of scope here.

- **The common-review-core extraction (§6.2) is partly done.** `ReviewableUnit`,
  `validateCandidate` and `applyVerification` exist in
  [`packages/review/src/core.ts`](../../packages/review/src/core.ts). What remains is the
  browser-side loop that calls them (§6.2, step 2) and everything downstream of it
  (`BrowserText`, the API surface, authentication) — scoped implementation work, not further
  pipeline extraction.
- The concrete authentication mechanism (§5) — still entirely open.
- Whether ranking/deduplication (`packages/review/src/ranking.ts`) should apply to browser
  findings at all — the GitHub path's five-inline-comment budget and dedup-by-overlapping-range
  logic assume a diff/PR context that a single ad hoc browser review may not need; an unranked,
  undeduplicated list may be sufficient for an MVP, but this is undecided.
- Whether `/extension/reviews` should be synchronous or should become an asynchronous
  submit-then-poll shape, given the request-timeout tension noted in §10.
- Final numeric limits for text length, body size, rate limits, quotas, and concurrency — all
  placeholders in this design.
- Whether a separate, smaller/cheaper default model tier should be configured for this route,
  distinct from an organization's GitHub-path reviewer/verifier configuration.
- Idempotency mechanics for a retried `requestId` — window length, storage (if any, however
  short-lived), and exact-duplicate-vs-conflicting-resubmission handling.
- Whether `GET /extension/reviews/:requestId` (or any polling/webhook-callback shape) is ever
  needed, and how it would honor the same ephemeral-by-default privacy rule if the answer isn't
  available synchronously.
- **The current `apps/api` → `OllamaProvider` wiring (`resolveExtensionPorts`,
  [`apps/api/src/main.ts`](../../apps/api/src/main.ts)) is a same-machine development
  convenience, not a production execution architecture.** It exists only so a developer running
  both `apps/api` and Ollama on one machine can manually test the Chrome extension end to end. A
  hosted `apps/api` deployment has no network path to a developer's or customer's local Ollama
  instance, so this wiring would simply fail every request with `PROVIDER_UNAVAILABLE` in a real
  deployment — it is not a working design for production browser-originated execution, only
  something that happens not to be reachable there. Where browser-originated model execution
  should actually happen in production (a cloud call from the control plane, routing through a
  customer's already-connected runner, or something else) remains an explicit open decision, not
  something this wiring should be read as having settled. The existing GitHub runner
  architecture — lease protocol, job-scoped tokens, ephemeral workspaces — is unchanged by any of
  this and is not a stand-in answer for it.
