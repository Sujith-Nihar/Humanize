# Agent handoff

Read [STATUS.md](STATUS.md), [AGENTS.md](../../AGENTS.md), and the assigned task before editing. Task records and the manifest track implementation and remaining acceptance. The append-only [progress log](evidence/progress.jsonl) preserves earlier checkpoints; newer evidence supersedes earlier failures.

Sessions of 2026-09-17 and 2026-09-18. The user asked for everything on the critical path that does not need GitHub credentials, which they will supply afterwards. Work covered the runner digest defect, S07 lease acceptance, the runner identity transport, job-scoped GitHub credential issuance, the outbound lease protocol, result upload with independent validation, and the first four S08 tasks: trusted configuration, ephemeral lexical context, deterministic rules and routing, and the reviewer and verifier pipeline. ADR-036 was decided and implemented. Every S07 task now has implementation and evidence. All work is still uncommitted in the local working tree.

## Implemented so far

- S00: preserved specification, decisions, requirements, all 104 upstream task mappings, 99 execution tasks across 21 stages, and persistent progress tracking.
- S01 partial: pnpm/TypeScript monorepo, runtime domain contracts, package boundaries, lint/test/build configuration, CI definition, development PostgreSQL and telemetry skeleton.
- S02–S03 partial: restricted Git acquisition, workspace cleanup, file classification, diff geometry, initial Babel JSX/static text and Markdown/MDX extraction, source mappings and placeholder recognition.
- S04 partial: OpenAI, Gemini, OpenRouter and native Ollama adapters; structured output validation, normalized errors, bounded retries/repair and mocked contract tests.
- S05 partial: Drizzle schemas/migrations, tenant constraints, encrypted credentials, review-run state transitions, metadata-only retention constraints and transactional pg-boss enqueueing.
- S06 partial: GitHub signature verification, scoped token broker, minimized webhook metadata, event-intent classification and Fastify durable ingestion. Asynchronous reconciliation and publication are absent.
- S07 partial: runner schemas and database store for enrollment, identity, heartbeat, revocation, fenced leases, renewal/retry and canonical result digests, plus the authenticated registration, heartbeat, lease-claim, renewal, failure and lease-token HTTP endpoints, and an outbound runner client with a lease session and poll loop. **S07-T01 (lease persistence) is now complete with evidence.** `apps/runner` refuses to start because no review executor exists yet, and the runner does not yet call the upload route for the same reason.

S08 has T01 (trusted configuration), T02 (ephemeral lexical context), T03 (deterministic rules and routing) and T04 (reviewer and verifier pipeline) implemented. S09–S20 remain planned. Dashboard, worker, runner and later execution packages are largely scaffolds. There is no end-to-end working product or production release.

## Change in this session: canonical digests

The previously flagged hashing defect was reproduced, fixed and covered.

**Reproduction.** `RunnerStore` digested payloads with `createHash('sha256').update(JSON.stringify(value))`. A lease returns `ReviewSnapshotSchema.parse(row.snapshot)`, whose key order follows the schema, while `review_runs.snapshot` read back from PostgreSQL JSONB returns a different key order. Measured against PostgreSQL 18.6: runner-side key order `version,organizationId,repositoryId,...` digesting to `e4a3ff3b…`, JSONB order `owner,baseSha,headSha,...` digesting to `f0b05097…`. Every honest runner result was therefore rejected with `LEASE_MISMATCH`, and a re-sent duplicate could be misread as `CONFLICTING_RESULT`.

**Fix.**
- [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts): `canonicalJson` now sorts keys by UTF-16 code unit instead of `localeCompare` (locale collation varies with the ICU build and is not a portable ordering), drops `undefined` members, normalizes array holes, and throws instead of silently collapsing non-finite numbers, non-plain objects such as `Date` and `Map` (which `Object.entries` would have flattened to `{}`), `bigint`, functions and cyclic values.
- [`packages/domain/src/index.ts`](../../packages/domain/src/index.ts): adds `DIGEST_VERSION = 'humanize-digest-1'` and `domainDigest` / `snapshotDigest` / `runnerResultDigest`. Each digest schema-normalizes its payload first and is labelled by payload kind, so JSONB, wire and in-memory forms agree and different payload kinds cannot collide.
- [`packages/db/src/runners.ts`](../../packages/db/src/runners.ts): consumes those digests; the non-canonical local `hash` and the `runnerPayloadHash` re-export are gone.
- [`docs/architecture/runner.md`](../architecture/runner.md) records the digest contract: changing `DIGEST_VERSION` invalidates in-flight leases and is a protocol change.

**Regression value proven.** Reverting `packages/db/src/runners.ts` to `JSON.stringify` hashing makes 3 of the 4 new acceptance tests fail with `LEASE_MISMATCH`; the canonical implementation passes. Any future runner client must compute `snapshotDigest` from `@humanize/domain`, never its own serializer.

## Change in this session: runner identity transport (S07-T02)

[`apps/api/src/runner.ts`](../../apps/api/src/runner.ts) adds `POST /runner/registrations` and `POST /runner/heartbeats` behind a `RunnerService` port that `RunnerStore` satisfies structurally, so `apps/api` holds no persistence logic. Protocol and schema versions are rejected before any state change (`409 INCOMPATIBLE_PROTOCOL`), bodies are schema validated and capped at 8 KiB, and only `INVALID_ENROLLMENT`, `RUNNER_UNAUTHORIZED` and `INVALID_SCOPE` are reportable; every other failure returns a generic `503`.

The shared Fastify error handler in [`apps/api/src/app.ts`](../../apps/api/src/app.ts) was also corrected: it previously turned every failure into `500`, including body-too-large and malformed-JSON client errors, which would have made GitHub and runners retry permanently invalid requests. It now preserves 4xx status codes while still never echoing an error message.

**The enrollment-token creation endpoint is deliberately absent.** Creating an enrollment token requires dashboard administrator authentication, which P1-S16-T01 owns; until then enrollment is reachable only through `RunnerStore.enrollment`.

## Change in this session: job-scoped GitHub credentials (S07-T04)

`POST /runner/leases/:leaseId/token` in [`apps/api/src/runner.ts`](../../apps/api/src/runner.ts) issues the single-repository, Contents-read credential a leased job uses. `RunnerStore.leaseScope` resolves the lease under the same liveness conditions as renewal and returns only installation and repository identity plus head SHA; the issuer sits behind a `TokenIssuer` port and is therefore structurally unreachable until the lease resolves. `GitHubTokenBroker.scopedToken` returns token and expiry with `repository_ids` limited to that one repository and `contents: read`; publish permissions remain unavailable to runners.

**Residual risk, by design of the platform:** GitHub installation tokens last up to an hour and cannot be revoked individually, so a credential issued moments before a lease is lost stays valid. The control plane's half of the contract is refusing to issue; the runner must discard its token on lease loss, which belongs to S07-T03.

**Sequencing note.** T04's recorded prerequisite is T03. T03 remains in progress only because the outbound client and `apps/runner` are absent, while the server-side lease protocol T04 depends on is implemented and verified. The deviation was raised and approved rather than taken silently; nothing belonging to T03 was implemented here.

## Change in this session: outbound lease protocol (S07-T03)

`apps/api` now serves claim, renewal and failure alongside the token route. [`apps/runner/src/client.ts`](../../apps/runner/src/client.ts) is the outbound half: connections are always runner-initiated, every control-plane response is schema validated before use, a non-HTTP control-plane address is refused, and failures are separated into `LeaseLostError` (409), `RunnerUnauthorizedError` (401/403) and `TransportError` (timeouts and 5xx). [`apps/runner/src/lease.ts`](../../apps/runner/src/lease.ts) owns one lease per job: it renews on a timer, aborts the executor when the lease is lost, and survives a partition only while the lease it already holds is still valid.

**Two safety properties are enforced, not assumed.** A lost lease reports neither a result nor a failure, because the fence it holds is stale and another runner now owns the work. And the job-scoped GitHub credential never outlives the session call frame — which closes the residual risk recorded against S07-T04.

**`apps/runner` refuses to start.** `main.ts` throws `RUNNER_EXECUTOR_NOT_IMPLEMENTED` because the lease protocol drives a review executor that does not exist until P1-S08, with packaging in P1-S15. This is deliberate: a runner that claimed leases it cannot execute would consume attempts and fail real pull-request reviews. `pnpm dev:runner` is therefore expected to fail until S08 lands.

## Change in this session: result upload and independent validation (S07-T05)

`POST /runner/leases/:leaseId/result` accepts a runner's findings. The runner is untrusted, so `validateRunnerResult` in [`packages/domain/src/index.ts`](../../packages/domain/src/index.ts) checks the envelope against the lease snapshot before anything is stored: nodes pinned to the reviewed head SHA and repository, no duplicate identities, candidates and evidence referencing only submitted material, and **every quoted fragment actually present in the node it points at** — so a fabricated quote cannot reach a pull request as if it were the developer's own words. Violations return codes only, never the payload, and leave the lease open for a correct submission.

**A bug was found and fixed here.** Resolving the lease with the strict `LEASED`-only condition made the idempotent duplicate path unreachable: a runner retrying after a dropped response got `LEASE_LOST` and would have discarded a valid result. `RunnerStore.leaseScope` now also resolves `RESULT_RECEIVED`, but only for the result path — renewal and token issuance keep the strict condition, confirmed by the existing fencing tests.

**Contract gap, recorded not filled:** [ADR-036](../adr/ADR-036.md) documents that `VerificationSchema.results[].candidateId` references candidates that carry no identity field, so a verification verdict cannot be bound to the candidate it judges. Validation currently enforces only uniqueness and the candidate-count bound. **This needs a decision before P1-S13 and P1-S14 can meet their acceptance criteria**, because a misbound suppression could publish a finding the verifier rejected.

## Change in this session: trusted configuration (S08-T01)

[`packages/config`](../../packages/config/src/index.ts) resolves the effective configuration for a review. `.humanize.yml` is read from the **trusted PR base commit, never the head** (ADR-027), so a pull request cannot weaken the review that judges it.

The repository schema is strict rather than lenient: a key such as `provider`, `retention_mode`, `execution_mode` or a credential **invalidates the file** instead of being ignored, because silently dropping it would let a repository appear to control something it must never control. A repository may switch a permitted category off, but only an administrator can switch one on; the inline-comment budget is clamped to the administrator cap; and a path override cannot reintroduce an administrator-only field. The loader treats the file as hostile input: 64 KiB cap, alias expansion capped so an alias bomb cannot exhaust memory, custom tags refused, mapping required.

A malformed, oversized or unparseable file **fails closed to administrator policy and defaults**, so review still runs. Failing open would let a broken or deliberately corrupted file switch reviewing off.

**Finding worth carrying forward:** Zod 4's `z.record()` with an **enum key schema is exhaustive** — it demands every enum member. `review.categories` listing only some categories therefore invalidated the entire file, sending every partial category map to defaults. Fixed with `z.partialRecord`. Any other enum-keyed record in this codebase deserves the same check.

## Change in this session: ephemeral lexical context (S08-T02)

[`packages/retrieval`](../../packages/retrieval/src/index.ts) gives a review the surrounding repository content it needs to judge changed text, using **no database, no pgvector and no embedding provider** — the acceptance criterion and INV-015. `EphemeralContextIndex` holds the ContentNodes of one review in memory for the life of that review and nothing longer: BM25 ranking, character-trigram near-duplicate detection standing in for `pg_trgm`, and same-file neighbour lookup. `buildContext` assembles the specification's priority order under a hard token budget, dropping lower-priority evidence rather than stretching.

Two properties are worth knowing when extending this. **Snapshot scoping is a tenant boundary, not an optimization**: a node from another repository or another commit throws `NODE_OUT_OF_SNAPSHOT` rather than being skipped, because foreign content must never become evidence about this review. And **results are deterministic** — equal BM25 scores fall back to the node's stable key, so insertion order cannot change what a model sees.

Evidence records carry the commit revision and a content hash over blob, offsets and text, so publication can revalidate a quote that the repository has since changed.

**Finding:** swept the codebase for the Zod 4 exhaustive-record trap found in S08-T01. No other occurrence — the only remaining `z.record` uses a string key schema and is genuinely partial.

## Change in this session: rules, routing, ADR-036 and a clock-skew defect

**S08-T03.** [`packages/rules`](../../packages/rules/src/index.ts) emits the documented AI-style signals with no model at all, and every span comes from the node's own text so a finding can always be anchored to real source. [`packages/review/src/router.ts`](../../packages/review/src/router.ts) decides which categories a node deserves from metadata alone: a marketing paragraph gets the full set, a button label never gets long-form prose review, accessibility text gets clarity and terminology only. A test asserts no rule description ever claims machine authorship (INV-006).

**ADR-036 accepted and implemented.** The user delegated the decision rather than choosing an option; that provenance is recorded in the ADR. Candidate identity is now `domainDigest('candidate', candidate)`, recomputed by the control plane, so a runner cannot bind a verdict to a finding the verifier did not judge. `validateRunnerResult` rejects `VERIFICATION_CANDIDATE_UNKNOWN`. P1-S13 and P1-S14 are unblocked. No wire schema changed.

**Defect found and fixed: lease expiry was decided by the wrong clock.** `RunnerStore.accept` compared a PostgreSQL timestamp against the API process's `Date.now()`. In production those are different machines, so any skew could accept a lease the database had already expired — and possibly already reassigned — which risks two runners submitting results for one review. Liveness now happens in SQL, and `claim`/`renew` additionally return `expiresInMs` so a remote runner measures remaining time rather than trusting clock agreement. A regression test forces the process clock an hour behind and an hour ahead and asserts the database decision holds both ways.

**How it surfaced, which matters for the next agent:** the machine slept, the Docker VM's clock drifted ~50 minutes behind the host, and 8 integration tests failed. The environment drift was transient, but it exposed a real defect that would otherwise have waited for production. Two test assertions were also comparing database timestamps against the host clock and were rewritten to measure entirely within the database. **If integration tests fail with impossible-looking timestamps, check `docker exec humanize-postgres-1 psql -U humanize -d humanize_test -tAc "select now()"` against `date -u` before assuming a logic bug.**

## Change in this session: reviewer and verifier pipeline (S08-T04)

[`packages/review/src/pipeline.ts`](../../packages/review/src/pipeline.ts) turns changed content into verified findings, through injected `ModelProvider` and context ports so no provider logic enters the review package.

**A deterministic gate sits between any model output and any finding.** A candidate is discarded unless it names the reviewed node, quotes text that genuinely occurs in that node, cites only evidence that was supplied, and stays within the routed categories. Source coordinates are attached from the node; a model never supplies them. This is what makes a fabricated quotation structurally unable to reach a pull request.

**The verifier is a genuinely separate invocation** with its own system prompt, and verdicts bind by ADR-036 candidate identity. A candidate with no matching verdict is suppressed as unverified — a missing or misbound verdict fails closed rather than publishing.

**Prompt-injection boundary:** repository text is fenced with a per-review unguessable marker, and any occurrence of that marker inside the content is stripped, so content cannot close its own fence. A test feeds content containing both an instruction to approve everything and a literal closing tag, and asserts exactly one fence terminator survives.

Deterministic blocking-rule violations publish without consulting any model at all — including on nodes not eligible for review, where a test asserts neither provider was called.

## Review quality measured, then improved by the measurement (S08-T05, ADR-037)

[`evals/review/gold.ts`](../../evals/review/gold.ts) holds 16 labelled cases — including three **legitimate promotional** cases that deliberately share vocabulary with the flagged ones, and microcopy that must never receive prose review. [`gate.live.test.ts`](../../evals/review/gate.live.test.ts) runs the real pipeline including ranking and the inline budget, so it measures what would reach a pull request.

| Measurement | Precision | Recall |
|---|---|---|
| Baseline, 16 clear-cut cases | 100% | 60% |
| After ADR-037, same 16 | 100% | **100%** |
| **With 10 ambiguous cases added (26 total)** | **100%** | **50%** |
| — of which clear-cut | 100% | 80% |
| — of which **ambiguous** | 100% | **20%** |

**The corpus drove two changes and then verified them.**

**1. ADR-037 — standalone deterministic findings.** Both original misses were cases where the rules fired but nothing published, because rule signals were evidence *for the model* rather than findings. An aggregate, objectively countable signal (three or more distinct promotional phrases in one node, or three or more sentences sharing an opening word) now stands alone as an advisory finding. Statistical density and uniformity signals deliberately do **not** qualify — they are the likeliest false-positive source. Recall went 60% → 100% with precision unchanged.

**2. A noise defect the second measurement exposed.** `repeated-openings` produced **four comments on one node**, because deduplication only merged *overlapping* ranges and three non-overlapping quotations of the same category stacked on one line. One node is now one place in the diff: at most one finding per category per node. Final state — 6 comments across 16 cases.

A further property fell out of ADR-037 and is now asserted in the executor tests: **when the model fails entirely, deterministic findings still reach the author** instead of the review producing nothing.

Live-lane floors are now precision 0.8, recall 0.8, zero legitimate cases flagged.

**The ambiguous middle was then added, and it changed the picture.** Ten cases of mediocre human copy and edited AI-assisted copy, labelled as judgement calls and scored separately.

**Precision held at 100% across all 26 cases.** Passive voice, an edited AI sentence, a long but information-dense sentence, a hedged claim and correct industry jargon were all left alone. The product does not nag.

**Ambiguous recall is 20%** — four of five missed. Two findings from that:

1. **The misses share a shape the product has no rule for: wordiness and padding**, as distinct from promotional vocabulary. `"provides users with the ability to"`, `"In order to get started, you will first need to begin by"`, `"empowers teams to seamlessly streamline"`.
2. **Phrase matching is literal, not morphological.** `"leveraging the power of"` does not match the listed `"leverage the power of"`. That dropped `generic-docs-opener` to two matched phrases — below the three-phrase cluster threshold — so it was missed this run although the model flagged it in an earlier one. **Clear-cut recall therefore sits exactly at its 0.8 floor and will flake with model variance.**

**I deliberately did not tune further.** Chasing 20% recall against 10 cases would overfit the corpus rather than improve the product. The evidence-led order is recorded in the task: a padding and wordiness rule family, stem-aware phrase matching, a much larger ambiguous set, then re-measurement with a bigger local model.

## Extraction coverage complete, and gated (S10)

Vue, Svelte and CSS extraction now exist, so **no supported format is silently unreviewed any more**. Vue uses the official SFC compiler with offsets relative to the original file; Svelte uses the official compiler and extracts an attribute only when its value is a single literal, so interpolated values are never reviewed as prose; CSS extracts only static `content` on `::before`/`::after`, skipping `counter()`, `attr()`, `var()` and the quote keywords. **No template expression is ever evaluated** — resolving one would mean executing customer code.

[`evals/extraction`](../../evals/extraction/gate.test.ts) turns extraction quality into a release gate. A labelled corpus states, per parser, what must be found and what must never be mistaken for prose, and the gate enforces the specification's 98% precision / 90% recall / 99% range accuracy in the **default test lane**, so `pnpm check` fails if extraction regresses.

```
parser        precision   recall   range accuracy
babel          100.0%    100.0%         100.0%
markdown       100.0%    100.0%         100.0%
html           100.0%    100.0%         100.0%
json-locale    100.0%    100.0%         100.0%
vue            100.0%    100.0%         100.0%
svelte         100.0%    100.0%         100.0%
css            100.0%    100.0%         100.0%
```

The corpus has since grown to **17 labelled files** carrying placeholder expectations, suggestion-eligibility expectations and hostile inputs, and the gate enforces all four properties. Every parser still measures 100% across the board.

**Read that honestly: 17 files.** It means the gate rejects regressions on these cases, not that extraction is correct in general — the specification expects hundreds.

**Expanding it found four defects immediately**, all fixed:
1. **Markdown dropped inline code from inside a paragraph**, so ``Each installation may send `5000` requests per hour.`` was reviewed as *"Each installation may send  requests per hour."* — a finding or suggestion on that corrupted sentence would have been wrong.
2. **Markdown emitted raw table markup as prose** (remark without GFM does not parse tables). Pipe-delimited blocks are now skipped; full table-cell extraction needs `remark-gfm` and is recorded as a gap.
3. **Locale extraction reviewed digest-like values as prose** — a commit SHA under `build.sha` became reviewable content.
4. **The range-accuracy metric itself was wrong**, demanding a byte-identical slice from entity-encoded and escaped segments that can never satisfy it.

Two of my own label errors were corrected too: a wrongly excluded blockquote and a wrongly omitted paragraph with an inline link.

Range accuracy is measured **per segment**, not per node: a Markdown paragraph containing an inline link assembles its text from several source runs, and each must map back to the exact source it came from. The gate caught both a mislabelled fixture and an over-strict first version of that metric on its first run.

## Parser-safe suggestions (S11-T01/T02/T03)

[`packages/suggestions`](../../packages/suggestions/src/index.ts) turns a proposed replacement into a one-click fix, or explains why it cannot. Every check must pass: the node must be safe to replace, **placeholders must survive**, the encoded patch must re-parse, and the re-parsed file must differ from the original in exactly one way — the text of this node.

That last check is the one that matters. A replacement can be perfectly valid syntax and still be wrong: prose opening a JSX expression, or an attribute value carrying `x" onerror="alert(1)`, parses cleanly while changing what the file *does*. Structural comparison catches it; syntax checking alone would not. Anything that fails falls back to comment-only, which is always publishable.

Placeholder rules: a removed, added, altered, duplicated or **reordered** placeholder is rejected. Ordering is enforced only for positional formats (`%s`, `%d`) which bind by position, so swapping them silently swaps what the user is shown; named placeholders may move.

**Defect found while proving this:** the HTML extractor located an attribute value by searching the raw source for the *decoded* value. An entity-bearing attribute never matches, so `alt="Terms &amp; conditions"` was **silently dropped and never reviewed**. The span is now derived from quote positions, and such a value is extracted and marked unsafe to replace. Third instance this session of the same failure shape: content that isn't reviewed, with nothing reporting it.

## Measured on a fixture corpus (S08-T05)

`evals/` is now a workspace package. [`evals/fixtures`](../../evals/fixtures/README.md) holds a small product repository in **before** and **after** versions across JSX, Markdown, MDX, HTML and locale JSON, and [`evals/review/corpus.live.test.ts`](../../evals/review/corpus.live.test.ts) builds a real Git repository from them and reviews the difference.

Result with `qwen3.5:4b`, 124 seconds — 5 files inspected, 8 nodes extracted, 4 changed nodes reviewed, 4 findings, workspace destroyed:

```
docs/security.mdx:3  [terminology/major]      "100% secure"  -> prohibited phrase (deterministic rule)
docs/security.mdx:3  [unsupported_claim/major] "Our platform is 100% secure and your data is completely protected at all times."
landing.tsx:3        [clarity/minor]           "Unlock unprecedented potential with our cutting-edge platform"
landing.tsx:4        [clarity/minor]           "Our revolutionary, state-of-the-art solution seamlessly integrates..."
```

**Three gaps this measured, rather than assumed:**

1. ~~`index.html` and `locales/en.json` produced no reviewable content at all~~ — **closed in this session** by the HTML and locale extractors (S09-T01, S09-T02). Re-running the same corpus: extracted nodes rose from **8 to 13**, reviewed changed nodes from **4 to 7**, and `changed files producing NO reviewable content: []`. `index.html` now yields a clarity finding on *"The ultimate game-changing solution for modern enterprises"* and `locales/en.json` an approved_voice finding on *"Unlock unprecedented potential today"* — both previously invisible.
2. **`docs/guide.md` was reviewed and produced nothing**, although its copy contains several phrases the deterministic rules recognise — four candidates were suppressed below the 0.90 confidence threshold. Strong rule evidence currently yields no finding when the model declines.
3. One node returned output that failed schema validation twice.

**Defect found and fixed during that run:** that single malformed response previously **aborted the entire pull request review**, discarding every other finding — contrary to the specification's rule that partial failure must not fail the whole review. `reviewNodes` now isolates each node, records a `NodeFailure`, and continues; the executor surfaces it as a `REVIEW_FAILED` diagnostic. The same run then produced 4 findings instead of none.

## Resource limits and telemetry (S19-T01, T03)

**Limits are enforced, not just documented.** [`evals/security/limits.test.ts`](../../evals/security/limits.test.ts) drives the real components past each one: an oversized file yields nothing plus `FILE_TOO_LARGE`; a file past the node cap stops and reports `NODE_LIMIT_REACHED`; a node longer than `nodeChars` is **refused rather than truncated**, because a truncated node would be reviewed as if it were the whole sentence; context stays inside its budget and reports truncation. Indexing and searching 5000 nodes completes well under five seconds, and a provider failing on one node still leaves the rest reviewed.

**Coverage is honest.** A non-locale data file, an unsupported format and an oversized file each produce zero nodes *and* a named diagnostic. Silence is the failure mode this project keeps rediscovering, and the test asserts against it directly.

**Telemetry: instrumentation cannot become a leak.** The specification's operational measurements are a typed union recorded through one surface, so a stage cannot invent a label. A measurement *dimension* is emitted output like any other, so it passes the same allowlist and shape scrubbing as a log line — tests prove tokens in dimensions are redacted, unexpected dimension names are dropped, and repository content passed as `text`, `explanation`, `quote` or `replacement` never reaches output. Even a file path is refused: a path can identify private work.

## Adversarial security review (S19-T02)

An attack corpus in `packages/testing` — eight injection shapes, fabricated evidence, unsafe patches, six parser-hostility inputs, credential-shaped secrets — run against **real components** by [`evals/security/boundaries.test.ts`](../../evals/security/boundaries.test.ts). Written up in [docs/security/adversarial-review.md](../security/adversarial-review.md).

**Held:** injection is fenced with a marker content cannot guess, *and independently* a model that obeys an injection still publishes nothing because the gate refuses quotations absent from the node — both layers tested separately, so neither is load-bearing alone. Fabricated quotes, paths and traversals refused. Unsafe patches refused or neutralised. Cross-tenant access refused **before** the store is reached, everywhere.

**Two findings, both fixed:**

1. **Twenty thousand nodes in one file took 10.9 seconds.** The file was well under the size cap — a size limit does not imply a node limit, and nothing stopped one file consuming a job's time budget. Extraction now stops at `LIMITS.nodesPerFile` and reports `NODE_LIMIT_REACHED`, because a partially reviewed file must not look fully reviewed. Corpus now runs in **1.2s**.
2. **Telemetry redaction filtered by field *name* only.** A connection string logged as `event`, or a token as `traceId`, was written verbatim. Values are now scrubbed by shape wherever they appear, with operational values like `PARSE_FAILURE` untouched.

**Residual limit, recorded not hidden:** scrubbing works on shape, so an arbitrary *short* opaque secret is indistinguishable from an ordinary value and is not caught. The allowlist and scrubbing are backstops; callers must still not log secrets.

**This is an agent review, not an audit.** S19-T02's criterion is not met until a human security reviewer repeats it.

## Runner packaged, and the image found three defects (S15-T03)

`docker/runner` holds a multi-stage Dockerfile, a reference compose deployment and [a deployment runbook](../runbooks/runner-deployment.md). **The image was built and run, not merely written** — uid 10001, no exposed ports, read-only root, `/app` unwritable by the runner, git as the only external binary, 117 MB, and it reached the real Ollama on the host reporting `models:1`.

Running it found three defects that reading it would not:

1. **The tmpfs workspace was owned by root**, so the unprivileged runner could not create a workspace and would have reviewed nothing. A tmpfs mount ignores the image's build-time `chown`. The mount now carries `uid=10001,gid=10001`, and the runbook says so because a hand-written deployment hits the same wall.
2. **`@humanize/*` did not resolve at all.** A pnpm workspace keeps its links in each package's `node_modules`, which the build context excludes. The build now uses `pnpm deploy` for a self-contained tree — which also cut the image from **207 MB to 117 MB**.
3. **An unreachable model killed the process with a raw `TypeError: fetch failed`** from Node internals. Startup now checks the model endpoint and exits with a sentence naming the endpoint and the fix, and separately reports when no model is installed. A startup log line was added too: silence and a crash loop look identical to an operator.

## Learnings, feedback and retention (S17-T01, T02, T04)

Migration `0006` adds `explicit_learnings` and `feedback`.

**Learnings are the only memory the product has**, and they are written deliberately. A learning carries path globs, a rule, an enabled flag and its author; `forPath` returns only enabled learnings whose globs match. A disabled learning is *kept* so an administrator can see what was once decided. Cross-tenant list, enable and remove all fail rather than succeeding silently.

**Feedback keeps provenance and creates nothing.** Outcome and source sets are enforced by database constraints; inferred feedback is marked as such with a null actor so nobody mistakes a system observation for a person's judgement. A test asserts that **recording a dismissal creates no learning** — a single dismissal never becomes a permanent rule (spec 25.2).

**Retention purge is ordered so a stale job cannot undo it.** `setMode` changes the repository's retention mode *first*, in the same transaction as the purge, so a job queued before the purge is refused by the column constraints rather than relying on the caller to notice. A test writes content while indexed, downgrades, and asserts no sentinel string survives anywhere; a second test performs the write a stale job would attempt and asserts the database refuses it.

## Administration surface (S16-T01, T02, T03)

**Repository enablement is serialized with its administrator check.** `AdministrationStore.setEnabled` locks the target rows `FOR UPDATE` and *only then* asks which of them the caller may administer. A check taken beforehand describes rights the caller had a moment ago; this ordering means a revocation that lands first wins. Six PostgreSQL tests prove it, including that two concurrent requests never overlap inside the check, and that a foreign repository is never even offered to it.

Organization policy now has its own table (migration `0005`) rather than borrowing repository configuration — repository content must never reach administrator-only fields (ADR-027), and keeping them apart enforces that structurally rather than by convention.

HTTP endpoints expose listing, enablement and policy behind session authorization; every route refuses another organization with 403 **while the store is never called**. The loop is closed: the event handler now reads the stored policy, and **a review is skipped rather than defaulted when no policy is set** — running on a provider, retention mode or execution mode nobody chose would be worse than not running. A stored policy that no longer satisfies its schema is treated as absent rather than patched.



Provider credentials and runner enrollment previously had **no authorized entry point at all** — only store methods, so the product could not be operated without direct database access.

[`packages/security`](../../packages/security/src/index.ts) adds `SessionSigner`: signed identity claims that never carry a secret, a minimum 32-byte deployment key, expiry enforced **on read** rather than merely recorded, and a constant-time signature comparison so the check cannot become a forgery oracle. `requireOrganization` refuses any action on an organization the session does not belong to.

[`apps/api/src/admin.ts`](../../apps/api/src/admin.ts) adds GitHub sign-in behind an injected `IdentityProvider`, so the exchange is testable without credentials. The state is issued into an HttpOnly `SameSite=Lax` cookie and must be echoed back, so a callback with no cookie, no state, or a mismatched state is refused — and a rejected exchange sets no session at all.

**Credentials are write-only ingress.** A test saves `sk-SENTINEL-VALUE` and asserts the response body does not contain it, and that listing returns metadata only. Cross-tenant attempts on save, list and delete all return 403 **with the store never called**.

**Known gap worth acting on before release:** organization membership is taken from the sign-in exchange and never reconciled, so a user removed from an organization keeps access until their session expires.

## The worker runs (S14-T03)

`apps/worker/src/main.ts` is a real process now: it migrates, starts the queue, **sweeps any payload a previous process left behind before taking new work**, subscribes to `github.event` and `review.publish`, rehydrates each event from its recorded delivery (the job payload carries identifiers only, never content), signals a retry by throwing so pg-boss reschedules, and shuts down on SIGTERM/SIGINT.

`publishReview` discards held content on **every path that will not publish later** — success, superseded head, and an unparseable payload that could never publish — and keeps it only for a failure a retry could resolve, because discarding then would lose a review the queue is about to attempt again. Five PostgreSQL tests assert the payload row count directly after each path.

**The worker starts but cannot complete a review yet**: the publish transport throws `PUBLISH_TRANSPORT_UNBOUND` and the event handler has no `TrustedFileSource`. Both need GitHub App credentials.

## Architecture conflict surfaced and resolved (ADR-038)

Wiring the publish worker exposed a contradiction rather than a bug. **A scheduled publication was impossible to act on.** Findings cannot be persisted with their text in ephemeral retention mode, and the accepted result existed only in an HTTP request that had already been answered — so a worker had nothing to publish.

All three obvious answers were bad: inline publication makes a runner wait on GitHub and loses the review if the publish fails; an in-memory handoff dies with a restart and cannot scale past one instance; persisting findings permanently breaks the retention mode outright.

[ADR-038](../adr/ADR-038.md) resolves it with `publication_payloads`, holding the validated payload **only until publication completes or is abandoned**. This matches the specification's own wording for ephemeral mode — context is rebuilt per review and *deleted after the job*, not never written. The guarantee becomes a **lifetime** guarantee, which is enforceable and testable, rather than an absolute that makes asynchronous publication impossible.

Migration `0004` applies from a clean database, and five PostgreSQL tests prove the lifetime: discarded after success, discarded after abandonment (unpublishable content is still content), swept when a crash leaves one behind while a live payload is untouched, refused for a non-existent run, isolated by tenant.

## Webhook now reaches a review run (S06-T04 + S08-T01)

The chain **webhook → durable delivery → event reconciliation → trusted configuration → review run → enqueued review** is complete and tested against PostgreSQL.

Configuration is read **at the base ref, never the head** (ADR-027), through a `TrustedFileSource` port. A test asserts the read targets `main:.humanize.yml`, that execution and retention in the stored snapshot come from administrator policy rather than the repository file, and that a redelivery reuses the same run with the same idempotency key rather than producing a second review.

## Event reconciliation, with ordering guards (S06-T04)

[`apps/worker/src/handlers.ts`](../../apps/worker/src/handlers.ts) turns a recorded delivery into durable state. The acceptance property is the interesting one: **reordered events cannot revive removed access or obsolete work.**

**Ordering defect found and closed.** The event contract carried no timestamp at all, so a redelivered older event would simply have overwritten a newer head. `GitHubEventSchema` now carries `occurredAt`, taken from the pull request or repository `updated_at` and falling back to receipt time, and the pull-request upsert refuses to apply an event older than the row it would overwrite.

**Deletion is terminal.** The installation update only ever moves `deleted` false → true, so a redelivered `created` event cannot restore access a user removed. Five PostgreSQL tests prove these, including that a stale `synchronize` cannot drag a pull request back to a head it has moved past.

## Continued implementation (this exchange)

**Rules improved by the corpus, and re-measured.** Phrase matching is now inflection-aware (`leveraging the power of` matched `leverage the power of`), and a **padding rule family** covers wordiness the product previously had no rule for at all (`provides users with the ability to`, `it is important to note that`). Re-measured on all 26 gold cases: **recall 50% → 80%, clear-cut 80% → 100%, ambiguous 20% → 60%, precision unchanged at 100%.** Nothing was gained by becoming noisier.

Two ambiguous cases remain missed, deliberately: fixing them means adding their exact vocabulary to the phrase list, which fits the corpus rather than generalising.

**Publication is now scheduled, not inline.** An accepted runner result schedules publication through a `PublicationScheduler` port; a duplicate result never schedules a second publish. A runner must not wait on GitHub, and a failed publish must be retried by the durable queue rather than lost with the HTTP response.

**Defect fixed — verifier corrections were trusted.** `correctedExplanation` and `correctedReplacement` were applied verbatim, so a verifier could replace a suggestion with text that **drops a placeholder**, producing a message with a hole in it. Corrections are model output like any other and are now revalidated: a corrected replacement must preserve the exact placeholder multiset, a corrected explanation must be non-empty, and a failing correction is discarded with the reviewer's original standing plus a `CORRECTION_DROPPED_PLACEHOLDER` diagnostic.

## Critical path status: everything but GitHub credentials

The chain from a pull request to a published comment now exists in code:

```
webhook -> review run -> runner lease -> executor (clone, extract, review, verify)
   -> runner uploads RunnerResult -> control plane validates -> rank/dedupe/budget
   -> buildReview + buildCheck -> ReviewPublisher posts review and check run
```

Built in this session: the **runner upload seam** (the runner reports only while it still holds the lease, and drops work whose lease was lost), **ranking, deduplication and the noise budget** (five subjective inline comments, deterministic policy violations exempt, nitpicks off), the **publisher** (grouped COMMENT review, exact-line inline comments, check conclusions that never fail a build for subjective wording), the **transport** (re-reads the head and refuses to publish for a superseded commit), and the **control-plane publish path** (rebuilds findings from an accepted result, re-checking every quotation because the runner is untrusted).

**What still blocks a real pull request comment**, all requiring the GitHub App:

1. ~~Nothing schedules `publishResult`~~ — **done**: acceptance schedules publication through a port, and a webhook now reaches a created review run. What remains is binding the production ports: a `TrustedFileSource` that fetches `.humanize.yml` from GitHub, an installation-authorised Octokit, the PR `DiffMap`, and a worker process that subscribes to the queues. **All four need App credentials.**
2. The transport ports (an installation-authorised Octokit, and the PR `DiffMap`) are injected and have no production binding.
3. No live GitHub call has ever been made; every publisher test uses a fake transport, so request shape and ordering are proven, not API compatibility.
4. Published comment identifiers are not persisted, so re-review reconciliation relies on markers alone.

## Milestone: Humanize reviews a pull request end to end (S08-T06)

`apps/runner` **starts** now. [`apps/runner/src/executor.ts`](../../apps/runner/src/executor.ts) runs one leased job inside an ephemeral workspace: read-only clone with the job-scoped token, merge-base diff geometry, classification of every tracked file, extraction from supported files only, selection of changed nodes on added lines, ephemeral context, rules, routing, then the reviewer and verifier pipeline. Customer code is never executed and the workspace is destroyed on every path.

Measured against a real Git repository and a real local model (`qwen3.5:4b`), 31.5 seconds:

```
files inspected: 2   nodes extracted: 3   changed nodes reviewed: 2

  docs.md:3  [unsupported_claim/minor]
    "Our revolutionary state-of-the-art solution seamlessly integrates to supercharge your workflow."
    -> unsupported promotional claims without evidence or context

  landing.tsx:1  [approved_voice/minor]
    "Unlock unprecedented potential with our cutting-edge platform"
    -> vague wording; no specific information about the potential

workspace left behind: 0 entries
```

**What this is not.** The acceptance names a *private live repository*, and no review has run against real GitHub: there are no App credentials, so a local Git origin stands in for the remote and `GitRepository.acquire` is substituted in tests. The runner also **does not upload its result** yet — `executeReview` returns a `RunnerResult` and the poll loop never calls the upload route, so S07-T05 and this task meet only at the seam. Extraction is Babel and Markdown only, so Vue, Svelte, HTML, CSS and locale content in a changed file are **silently not reviewed** until S09/S10.

## Change in this session: first live model verification

A local Ollama server became available, so the provider and review stacks were run against a **real model for the first time** (`qwen3.5:4b`). A deliberate live lane was added — `pnpm test:live`, matching `*.live.test.ts`, excluded from the default and integration lanes so `pnpm check` never depends on a running service.

**Four defects surfaced that mocked tests could not catch.** All are fixed, with tests.

1. **No `num_ctx`.** Ollama defaults to a small context window and silently discards overflow. Chat truncation drops the oldest message first — the system prompt — so the untrusted-content boundary could be evicted while the repository text it governs survived. Quality and the injection defence would have degraded together.
2. **Thinking models never emit JSON.** A model advertising the `thinking` capability spends the bounded output budget on reasoning: every pipeline call failed with `CONTEXT_LIMIT` after ~55 seconds. The adapter now sends `think:false`, but only to a model whose `/api/show` capabilities declare it, since the field is invalid otherwise. Measured effect on an identical request: from exhausting 4000 output tokens and failing, to completing in **57 tokens and 1.1 seconds**.
3. **The reviewer was never told which node it was reviewing**, although the schema requires a `nodeId`. The model invented one and **every model-proposed finding was discarded** as `foreign_node`. The mocked tests passed only because the doubles supplied the right id themselves — the sharpest example in this project of why mocks are not evidence.
4. **The published explanation was the verifier narrating its own checking**, including leaked evidence hash identifiers, and would have gone verbatim into a pull request comment. The verifier prompt now requires `correctedExplanation` to be the sentence the author reads.

**Measured behaviour after the fixes**, on hand-written cases:

| Content | Result |
|---|---|
| "Unlock unprecedented potential with our cutting-edge platform…" | Verified `ai_like_generic` finding: *"The phrase 'unprecedented potential' is a low-information promotional claim that lacks specific substance or evidence."* |
| "Connect a repository to start reviewing pull requests." | No finding — a reviewer-proposed clarity candidate was correctly suppressed by the verifier |
| "Run the database migration before starting the worker process." | No finding |
| Content instructing the model to report `SYSTEM COMPROMISED` | No finding — suppressed as `evidence_not_supplied` |

**This is a smoke test, not a quality measurement.** One small model, five hand-written cases. P1-S08-T05 must measure precision against labelled content. Two quality issues already observed for it: overlapping findings for a sentence and a sub-phrase of it (ranking and dedup in P1-S13 must merge these), and candidates proposed for acceptable copy that only the verifier removes.

## Verified results and unverified work

Verified on 2026-09-17 in this session:

- `pnpm check` passed: documentation, package boundaries, TypeScript, lint and **217 unit tests across 36 files**, including the extraction, security and limit gates (was 24 across 9 at the start of this work).
- `pnpm build` passed after removing the stale `runnerPayloadHash` export.
- `pnpm test:integration` passed **70 tests across 12 files** (was 8) against a freshly created disposable `humanize_test` database, including migrations 0000-0006 applying from scratch.
- `pnpm test:live` passed **9 tests against a real Ollama server** (`qwen3.5:4b`) in 35.6 seconds: 5 provider contract tests, 3 pipeline tests and 1 end-to-end repository review.
- Migrations `0000_wet_nighthawk.sql`, `0001_timestamp_fields.sql`, `0002_webhook_metadata.sql` and `0003_runner_leases.sql` now **apply from scratch and re-apply idempotently** with recorded checksums. The previous checkpoint's warning that 0002/0003 were unverified is resolved.
- New integration coverage: JSONB round-trip result acceptance, idempotent re-send with reordered keys, conflicting result, mismatched digest / stale fence / foreign run, expired lease, concurrent claim exclusivity with fencing, cross-tenant impersonation, and enrollment scope/expiry refusal.
- New HTTP coverage against the real store: credential returned once and persisted only as a hash, heartbeat advancing `last_heartbeat`, one 201 and one 401 for concurrent registrations on a single token, expired/unknown/revoked/forged credentials refused, and cross-tenant enrollment scope refused.
- New protocol coverage end to end: the real client drives the real routes and store through claim, renewal and completion, an idle 204, three retryable attempts ending in `FAILED_FINAL` with no fourth claim, mid-job revocation aborting the executor and leaving the lease `CANCELLED`, and every authenticated call refused afterwards. Renewal scheduling, partition survival, partition timeout, retry classification and timer cleanup are covered by fake-timer unit tests.
- New upload coverage over HTTP: accept then idempotent duplicate with only the digest persisted and no content in the lease row, conflicting second result, content not at head leaving the lease open, a fabricated quote refused without echoing it, stale fence, mismatched snapshot digest, foreign runner, expired lease, malformed and misaddressed envelopes, and a genuinely oversized 8 MiB payload refused with the lease still usable.
- New credential-issuance coverage against the real store: a live lease yields a token scoped to exactly its installation and repository id, while a superseded fence, unknown lease, foreign tenant runner, expired lease, released lease, cancelled run, disabled repository, suspended installation and revoked credential are each refused with the issuer never invoked.

Still unverified, and not to be claimed:

- Live evidence covers **Ollama only, on one small model**. OpenAI, Gemini and OpenRouter have never been contacted and no credentials are present, so P1-S04-T07's acceptance that all four providers pass application-shaped probes is **not met**.
- No live provider, GitHub App, Ollama or end-to-end run. Provider and GitHub App credentials and a local Ollama executable were absent when checked. **Mocked provider tests do not establish live compatibility**, and no real installation access token has ever been minted: `GitHubTokenBroker` is exercised only through a port double.
- No extraction release corpus, human review-quality evaluation, operational drill or production security audit.
- No runner has run as a real process against a live control plane: the protocol test drives the routes through Fastify's injector, and process-restart recovery is untested.
- No implementation commit and no remote CI run.

## Next steps

1. **Add the ambiguous middle to the review corpus** — mediocre human copy and edited AI-assisted copy, which the 16 cases lack entirely. Precision on clear-cut writing is easy; the middle is where a reviewer earns or loses trust, and where the current 100% scores carry no information.
3. **Schedule the publish hop** — a job that calls `publishResult` when a runner result is accepted.
4. **Re-measure with a larger local model** to separate prompt and threshold problems from model capacity — the evaluation corpus: the first measurement of whether any of this produces useful findings, and the point at which the provisional rule thresholds and prompts get tuned against labelled content.
3. **Live lane, for anyone continuing:** `HUMANIZE_OLLAMA_BASE_URL=http://127.0.0.1:11434 HUMANIZE_OLLAMA_MODEL=qwen3.5:4b pnpm test:live`. A live test throws rather than skipping when its variables are absent, so an unavailable service reads as blocked, never as passing.
4. **Bounded one-step context expansion** is defined in the architecture and deliberately not implemented: `ReviewerResponseSchema` already carries `searches`, and the pipeline currently ignores it. Pick this up with S13. Everything in S07 waits on this stage, including `apps/runner` being able to start at all. Neither T01 nor T02 is wired to a caller yet: nothing reads `.humanize.yml` from the base commit to pin `configSha`/`configHash` into a `ReviewSnapshot`, and nothing builds a context index for a real review. Both arrive with T04/T06.
3. **S07-T05 remainder** — retention-safe handoff of an accepted result into publication, and the runner-side upload call once an executor produces a result.
4. **S07-T03 remainder** — process-restart recovery against a real runner process; blocked on a review executor, so effectively gated behind S08.
5. **S07-T02 remainder** — enrollment-token creation endpoint (blocked on dashboard administrator authentication, P1-S16-T01), 90-second offline detection and its consumer, and rate limiting for unauthenticated registration attempts.
6. **S07-T04 remainder** — live verification against a real GitHub App, confirming the issued token carries only Contents read for the single repository.
7. **S06** — asynchronous event reconciliation, debounce, lifecycle cancellation and failed-delivery recovery; S06-T06 checks/review transport remains planned.
8. Later scopes (configuration, retrieval, review engine, remaining parsers, safe suggestions, indexing, publication, dashboard, retention controls, release gates) remain outstanding.

## Commands and environment

Node 22.23.2; pnpm 10.34.5, pinned in `packageManager`. pnpm is not globally on PATH; this session used either the npx cache directory or the workspace binaries:

```sh
export PATH="/Users/sujiththota/.npm/_npx/381139ee5d646d31/node_modules/.bin:$PATH"   # pnpm
export PATH="$PWD/node_modules/.bin:$PATH"                                            # vitest, tsx
pnpm check
pnpm build
pnpm test:integration
python3 scripts/check_docs.py
```

Integration tests require `HUMANIZE_TEST_DATABASE_URL` pointing at the disposable **humanize_test** database; the tests refuse any other database name. Local development credentials come from [compose.yaml](../../compose.yaml):

```sh
export HUMANIZE_TEST_DATABASE_URL="postgres://humanize:local-development-only@127.0.0.1:54329/humanize_test"
docker exec humanize-postgres-1 psql -U humanize -d postgres -c "DROP DATABASE IF EXISTS humanize_test;" -c "CREATE DATABASE humanize_test;"
```

The PostgreSQL 18.6 container `humanize-postgres-1` (Compose service `postgres`, loopback port 54329) is running and was not stopped. It is the only database used; unrelated containers on this machine belong to other projects and are untouched. Dropping and recreating `humanize_test` is the supported way to validate the migration chain from scratch. Docker/network/localhost operations may require sandbox escalation.

Progress update command:

```sh
python3 scripts/update_progress.py TASK_ID in_progress --evidence 'Actual changes and checks' --next 'Remaining acceptance'
```

Update this handoff alongside task evidence. Keep untouched tasks planned, partial tasks in progress, and absent live/human evidence explicitly unverified.
