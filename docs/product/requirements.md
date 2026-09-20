# Requirements and verification matrix

Source: [upstream specification](../spec/Humanize_Final_Engineering_Build_Spec.md). Task documents own acceptance tests and evidence; this matrix owns requirement mapping.

| ID | Requirement | Subsystems/stages and task acceptance |
|---|---|---|
| FR-01 | App lifecycle | [P1-S06](../implementation/README.md#p1-s06--github-ingestion-and-early-race-proof), [P1-S16](../implementation/README.md#p1-s16--authentication-and-administration-dashboard) |
| FR-02 | PR event processing | [P1-S06](../implementation/README.md#p1-s06--github-ingestion-and-early-race-proof) |
| FR-03 | Complete inventory | [P1-S02](../implementation/README.md#p1-s02--restricted-repository-acquisition-and-diff-geometry) |
| FR-04 | JSX/TS/JS extraction | [P1-S03](../implementation/README.md#p1-s03--first-extraction-and-source-range-proof) |
| FR-05 | Markdown/MDX extraction | [P1-S03](../implementation/README.md#p1-s03--first-extraction-and-source-range-proof) |
| FR-06 | HTML accessibility and metadata | [P1-S09](../implementation/README.md#p1-s09--html-localization-and-deterministic-resolution) |
| FR-07 | Localization and resolution | [P1-S09](../implementation/README.md#p1-s09--html-localization-and-deterministic-resolution) |
| FR-08 | Vue Svelte CSS | [P1-S10](../implementation/README.md#p1-s10--vue-svelte-css-and-extraction-gate) |
| FR-09 | Source and diff geometry | [P1-S02](../implementation/README.md#p1-s02--restricted-repository-acquisition-and-diff-geometry), [P1-S03](../implementation/README.md#p1-s03--first-extraction-and-source-range-proof) |
| FR-10 | Baselines cache and incremental scans | [P1-S12](../implementation/README.md#p1-s12--indexed-baselines-and-production-retrieval) |
| FR-11 | Context and retrieval | [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S12](../implementation/README.md#p1-s12--indexed-baselines-and-production-retrieval) |
| FR-12 | Approved voice separation | [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S12](../implementation/README.md#p1-s12--indexed-baselines-and-production-retrieval) |
| FR-13 | Eight review categories | [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S13](../implementation/README.md#p1-s13--complete-review-verification-and-noise-policy) |
| FR-14 | Evidence and verification | [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S13](../implementation/README.md#p1-s13--complete-review-verification-and-noise-policy) |
| FR-15 | Ranking dedupe and noise | [P1-S13](../implementation/README.md#p1-s13--complete-review-verification-and-noise-policy) |
| FR-16 | Safe suggestions | [P1-S11](../implementation/README.md#p1-s11--parser-safe-suggestions) |
| FR-17 | Reviews and checks | [P1-S06](../implementation/README.md#p1-s06--github-ingestion-and-early-race-proof), [P1-S14](../implementation/README.md#p1-s14--production-github-publication) |
| FR-18 | Provider contract | [P1-S04](../implementation/README.md#p1-s04--all-four-provider-contracts) |
| FR-19 | Provider administration | [P1-S16](../implementation/README.md#p1-s16--authentication-and-administration-dashboard) |
| FR-20 | Runner lifecycle | [P1-S07](../implementation/README.md#p1-s07--runner-identity-and-lease-protocol), [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S15](../implementation/README.md#p1-s15--production-runner-execution-and-distribution) |
| FR-21 | Configuration | [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S16](../implementation/README.md#p1-s16--authentication-and-administration-dashboard) |
| FR-22 | Explicit knowledge and feedback | [P1-S17](../implementation/README.md#p1-s17--learnings-feedback-history-and-retention) |
| FR-23 | Dashboard and history | [P1-S16](../implementation/README.md#p1-s16--authentication-and-administration-dashboard), [P1-S17](../implementation/README.md#p1-s17--learnings-feedback-history-and-retention) |
| FR-24 | Retention modes | [P1-S05](../implementation/README.md#p1-s05--durable-state-secrets-and-scheduling), [P1-S12](../implementation/README.md#p1-s12--indexed-baselines-and-production-retrieval), [P1-S17](../implementation/README.md#p1-s17--learnings-feedback-history-and-retention) |
| FR-25 | Optional embeddings | [P1-S18](../implementation/README.md#p1-s18--optional-embeddings-and-vector-retrieval) |
| SEC-01 | No repository execution | [P1-S02](../implementation/README.md#p1-s02--restricted-repository-acquisition-and-diff-geometry), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| SEC-02 | Ephemeral source | [P1-S02](../implementation/README.md#p1-s02--restricted-repository-acquisition-and-diff-geometry), [P1-S15](../implementation/README.md#p1-s15--production-runner-execution-and-distribution), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| SEC-03 | Untrusted evidence and output | [P1-S01](../implementation/README.md#p1-s01--monorepo-and-executable-contracts), [P1-S03](../implementation/README.md#p1-s03--first-extraction-and-source-range-proof), [P1-S04](../implementation/README.md#p1-s04--all-four-provider-contracts), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| SEC-04 | Least privilege and secrets | [P1-S04](../implementation/README.md#p1-s04--all-four-provider-contracts), [P1-S05](../implementation/README.md#p1-s05--durable-state-secrets-and-scheduling), [P1-S06](../implementation/README.md#p1-s06--github-ingestion-and-early-race-proof), [P1-S07](../implementation/README.md#p1-s07--runner-identity-and-lease-protocol), [P1-S15](../implementation/README.md#p1-s15--production-runner-execution-and-distribution), [P1-S16](../implementation/README.md#p1-s16--authentication-and-administration-dashboard), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| SEC-05 | Tenant authorization | [P1-S05](../implementation/README.md#p1-s05--durable-state-secrets-and-scheduling), [P1-S07](../implementation/README.md#p1-s07--runner-identity-and-lease-protocol), [P1-S16](../implementation/README.md#p1-s16--authentication-and-administration-dashboard), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| SEC-06 | Webhook security | [P1-S06](../implementation/README.md#p1-s06--github-ingestion-and-early-race-proof), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| SEC-07 | Suggestion safety | [P1-S11](../implementation/README.md#p1-s11--parser-safe-suggestions), [P1-S14](../implementation/README.md#p1-s14--production-github-publication), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| NFR-01 | Durable execution | [P1-S05](../implementation/README.md#p1-s05--durable-state-secrets-and-scheduling), [P1-S07](../implementation/README.md#p1-s07--runner-identity-and-lease-protocol), [P1-S15](../implementation/README.md#p1-s15--production-runner-execution-and-distribution) |
| NFR-02 | Idempotency and freshness | [P1-S05](../implementation/README.md#p1-s05--durable-state-secrets-and-scheduling), [P1-S06](../implementation/README.md#p1-s06--github-ingestion-and-early-race-proof), [P1-S14](../implementation/README.md#p1-s14--production-github-publication) |
| NFR-03 | Resource and failure isolation | [P1-S02](../implementation/README.md#p1-s02--restricted-repository-acquisition-and-diff-geometry), [P1-S09](../implementation/README.md#p1-s09--html-localization-and-deterministic-resolution), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| NFR-04 | Extraction quality | [P1-S01](../implementation/README.md#p1-s01--monorepo-and-executable-contracts), [P1-S03](../implementation/README.md#p1-s03--first-extraction-and-source-range-proof), [P1-S09](../implementation/README.md#p1-s09--html-localization-and-deterministic-resolution), [P1-S10](../implementation/README.md#p1-s10--vue-svelte-css-and-extraction-gate), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| NFR-05 | Review quality | [P1-S01](../implementation/README.md#p1-s01--monorepo-and-executable-contracts), [P1-S08](../implementation/README.md#p1-s08--first-useful-review-and-runner-vertical-slice), [P1-S13](../implementation/README.md#p1-s13--complete-review-verification-and-noise-policy), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| NFR-06 | Observability | [P1-S01](../implementation/README.md#p1-s01--monorepo-and-executable-contracts), [P1-S19](../implementation/README.md#p1-s19--security-observability-and-final-evaluation) |
| NFR-07 | Operability | [P1-S15](../implementation/README.md#p1-s15--production-runner-execution-and-distribution), [P1-S20](../implementation/README.md#p1-s20--deployment-recovery-and-release-acceptance) |

## Invariant coverage

| Invariant | Requirement | Acceptance |
|---|---|---|
| INV-001 | SEC-01 | Humanize must never execute scripts, package managers, builds, tests, binaries, or hooks from customer repositories. |
| INV-002 | SEC-02 | Humanize must never persist a complete repository checkout after a job finishes. |
| INV-003 | SEC-03 | Repository content is untrusted data and must never be interpreted as system instructions. |
| INV-004 | FR-09,SEC-07 | Every published inline finding must map to a real file path and source range validated deterministically. |
| INV-005 | FR-16,SEC-07 | Every one-click suggestion must pass a parser-specific safety check before publication. |
| INV-006 | FR-13 | Humanize must never claim certainty that content was authored by AI. |
| INV-007 | SEC-04,FR-18,FR-20 | Humanize must never silently switch from Ollama/private execution to a cloud model. |
| INV-008 | SEC-04 | Provider secrets must never appear in logs, PR comments, prompts, client-side JavaScript, or repository configuration. |
| INV-009 | NFR-02 | Duplicate GitHub webhook delivery must not create duplicate reviews or comments. |
| INV-010 | NFR-02 | Findings generated for a stale PR head SHA must never be published as current findings. |
| INV-011 | SEC-04 | The GitHub App must not require Contents write permission in Phase 1. |
| INV-012 | FR-12 | A repository baseline must not be treated as approved brand voice unless explicitly configured as an approved source. |
| INV-013 | SEC-03 | No model response may be trusted without schema validation. |
| INV-014 | FR-09,SEC-03 | A model-generated line number may never be used as the source of truth for GitHub line mapping. |
| INV-015 | FR-25 | The system must remain functional if semantic embeddings are disabled. |
| INV-016 | FR-03 | Humanize must enumerate every tracked file in scope, even though many files will be deterministically classified as non-content and skipped without LLM processing. |

SEC-GH-001, SEC-GH-002 and SEC-GH-003 map to SEC-06 and P1-S06-T02/T03. Concrete executable tests and completion evidence are linked from each task record; a mapping is not a claim of implementation.
