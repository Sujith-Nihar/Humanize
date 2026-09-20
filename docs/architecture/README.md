# Architecture and contracts

Humanize keeps the approved four apps (`api`, `dashboard`, `worker`, `runner`) and the packages listed in upstream §7. Apps compose adapters; execution packages depend on domain ports; domain depends only on pure shared utilities. The review package must not import database, GitHub or provider SDK implementations. Production packages cannot import testing.

- `api`: raw authenticated webhooks, tenant-authorized configuration, runner leases and control-plane publication.
- `dashboard`: administration through authenticated API only; no database or saved credentials in browser responses.
- `worker`: cloud scans/reviews with read-only GitHub access.
- `runner`: outbound local scans/reviews using Ollama, no cloud credentials or DB access.
- `domain`: Zod contracts, IDs, states, ports and protocol versions.
- `db`: Drizzle migrations, scoped persistence, transactions and retention.
- `queue`: pg-boss typed durable metadata-only jobs.
- `github`: auth/token broker, diff geometry, reviews/checks and reconciliation.
- `config`: data-only trusted-base YAML, administrator policy and immutable snapshots.
- `scanner`: ephemeral Git acquisition, full inventory/classification and limits.
- `extractors`: official parser adapters, visible text and source maps; ASTs transient.
- `content-index`: rebuildable, atomically activated baseline generations and blob cache.
- `retrieval`: bounded snapshot-scoped lexical retrieval, optional vectors.
- `rules`: versioned deterministic signals/policies, no authorship verdicts.
- `review`: routing, model orchestration, evidence validation, verification and noise policy.
- `providers`: provider-specific requests/auth/errors/usage and capability tests.
- `suggestions`: encoding, placeholders, structural proof and representable diff patches.
- `security`: secret encryption and policy/authorization primitives.
- `telemetry`: redacted logs/traces/metrics; `testing`: trusted fixtures; `shared`: pure utilities only.

## Contract semantics

Source ranges are zero-based UTF-16 half-open intervals with one-based inclusive lines. Preserve original newlines. Visible/source segment maps distinguish decoded entities and discontinuous markup from raw source. Models identify nodes/evidence; they never supply authoritative coordinates. Node identities include repository, commit, blob, parser/version and extraction configuration; stable keys exclude commit identity.

ReviewSnapshot pins tenant/repository, PR, base/head/config SHAs, config digest, retention/execution mode, model profiles and protocol versions. DiffMap uses merge-base to head, RIGHT-side changes and GitHub-representable ranges. Provider and retrieval behavior enters review through injected ports. All external JSON is schema validated, including runner results and every model response.

## Review behavior

Snapshot → inventory → deterministic extraction → changed-node selection → rules → bounded context → category routing → structured reviewer → deterministic evidence validation → at most one expansion (three queries) → separate verifier → revalidation → ranking/dedupe → five subjective active inline findings per PR → safe suggestions → control-plane publication. Verify every publishable model-generated finding initially; deterministic policy findings need no model. Reviewer/verifier confidence thresholds start at 0.90; they are heuristics, not calibrated probabilities. No nitpicks by default. Missing repository support is not proof a claim is false.

Configuration precedence: hard invariants, organization policy, trusted-base repository config, path-specific config, explicit learnings, defaults. Repository content cannot select provider endpoints, credentials, execution or retention. `.humanize.yml` is read from the trusted PR base commit, never the head, so a pull request cannot weaken its own review. The repository schema is strict: an administrator-only key invalidates the file rather than being ignored, a repository may switch a permitted category off but never switch on one the administrator withheld, and the inline-comment budget is clamped to the administrator cap. A malformed, oversized or unparseable file fails closed to administrator policy and defaults, so review still runs; a broken file must never silently switch reviewing off. Baseline statistics never imply approved voice. Initial language gate is English; other language/model combinations require explicit opt-in.

## Limits

Initial limits: 1 MiB/file, 10,000 UTF-16 units/node, 5 seconds/parser, 256 MiB/parser worker, 200 files/batch, 20 nodes/model batch, at most 12,000 input and 4,000 output tokens constrained by model capability, 30 minutes/job and 4 GiB/workspace. Limits produce explicit partial/incomplete coverage, never silent success.

See [data lifecycle](data.md), [providers](providers.md), [runner](runner.md), [GitHub](github.md), [security](../security/README.md), and [concern dispositions](concerns.md).
