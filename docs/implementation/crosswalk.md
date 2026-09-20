# Upstream task crosswalk

Upstream task IDs remain unchanged. One task may be fulfilled across several execution tasks; all required evidence is necessary.

| Upstream task | Requirement | Execution tasks |
|---|---|---|
| P1-S0-001 | Create pnpm TypeScript monorepo and package boundaries | [P1-S01-T01](tasks/P1-S01-T01.md) |
| P1-S0-002 | Add shared Zod domain contracts | [P1-S01-T02](tasks/P1-S01-T02.md) |
| P1-S0-003 | Add lint/format/typecheck/test CI | [P1-S01-T03](tasks/P1-S01-T03.md) |
| P1-S0-004 | Add Docker Compose local Postgres | [P1-S01-T04](tasks/P1-S01-T04.md) |
| P1-S0-005 | Add ADR template and architecture docs | [P1-S00-T02](tasks/P1-S00-T02.md) |
| P1-S0-006 | Add AGENTS.md and CLAUDE.md with non-negotiable invariants | [P1-S00-T03](tasks/P1-S00-T03.md) |
| P1-S1-001 | Drizzle schema for organizations/users/installations/repos/config | [P1-S05-T01](tasks/P1-S05-T01.md) |
| P1-S1-002 | Review-run, finding, webhook-delivery schemas | [P1-S05-T02](tasks/P1-S05-T02.md) |
| P1-S1-003 | Runner and lease schemas | [P1-S07-T01](tasks/P1-S07-T01.md) |
| P1-S1-004 | SecretStore abstraction and encrypted Postgres implementation | [P1-S05-T03](tasks/P1-S05-T03.md) |
| P1-S1-005 | pg-boss typed JobQueue wrapper | [P1-S05-T04](tasks/P1-S05-T04.md) |
| P1-S1-006 | Review state-machine service | [P1-S05-T05](tasks/P1-S05-T05.md) |
| P1-S2-001 | GitHub App JWT + installation token service | [P1-S06-T01](tasks/P1-S06-T01.md) |
| P1-S2-002 | raw-body webhook signature verification | [P1-S06-T02](tasks/P1-S06-T02.md) |
| P1-S2-003 | webhook idempotency using delivery GUID | [P1-S06-T03](tasks/P1-S06-T03.md) |
| P1-S2-004 | installation / repository event handlers | [P1-S06-T04](tasks/P1-S06-T04.md) |
| P1-S2-005 | pull_request event router | [P1-S06-T04](tasks/P1-S06-T04.md) |
| P1-S2-006 | push handler for default-branch index updates | [P1-S06-T05](tasks/P1-S06-T05.md) |
| P1-S2-007 | Check Run create/update service | [P1-S06-T06](tasks/P1-S06-T06.md) |
| P1-S2-008 | PR review publisher and summary upsert | [P1-S06-T06](tasks/P1-S06-T06.md) |
| P1-S3-001 | restricted git process wrapper | [P1-S02-T01](tasks/P1-S02-T01.md) |
| P1-S3-002 | ephemeral workspace lifecycle | [P1-S02-T02](tasks/P1-S02-T02.md) |
| P1-S3-003 | read-only clone/fetch by scoped installation token | [P1-S02-T01](tasks/P1-S02-T01.md) |
| P1-S3-004 | enumerate every tracked file | [P1-S02-T03](tasks/P1-S02-T03.md) |
| P1-S3-005 | deterministic file classifier | [P1-S02-T03](tasks/P1-S02-T03.md) |
| P1-S3-006 | path/size/binary/generated exclusion engine | [P1-S02-T03](tasks/P1-S02-T03.md) |
| P1-S3-007 | local diff + changed-line map | [P1-S02-T04](tasks/P1-S02-T04.md) |
| P1-S4-001 | ContentNode domain + stable-key/fingerprint | [P1-S03-T01](tasks/P1-S03-T01.md) |
| P1-S4-002 | Babel TS/JS/JSX/TSX extractor | [P1-S03-T02](tasks/P1-S03-T02.md) |
| P1-S4-003 | HTML extractor | [P1-S09-T01](tasks/P1-S09-T01.md) |
| P1-S4-004 | Markdown/MDX extractor | [P1-S03-T03](tasks/P1-S03-T03.md) |
| P1-S4-005 | Vue extractor | [P1-S10-T01](tasks/P1-S10-T01.md) |
| P1-S4-006 | Svelte extractor | [P1-S10-T02](tasks/P1-S10-T02.md) |
| P1-S4-007 | JSON/YAML locale extractor | [P1-S09-T02](tasks/P1-S09-T02.md) |
| P1-S4-008 | CSS generated-content extractor | [P1-S10-T03](tasks/P1-S10-T03.md) |
| P1-S4-009 | visible-prop / visible-call configurable rules | [P1-S03-T02](tasks/P1-S03-T02.md) |
| P1-S4-010 | placeholder extraction and preservation metadata | [P1-S03-T04](tasks/P1-S03-T04.md), [P1-S09-T04](tasks/P1-S09-T04.md) |
| P1-S4-011 | extraction benchmark runner | [P1-S03-T05](tasks/P1-S03-T05.md), [P1-S09-T04](tasks/P1-S09-T04.md), [P1-S10-T04](tasks/P1-S10-T04.md) |
| P1-S5-001 | baseline scan persistence | [P1-S12-T01](tasks/P1-S12-T01.md) |
| P1-S5-002 | blob extraction cache | [P1-S12-T02](tasks/P1-S12-T02.md) |
| P1-S5-003 | incremental default-branch update | [P1-S12-T03](tasks/P1-S12-T03.md) |
| P1-S5-004 | Postgres FTS index | [P1-S12-T04](tasks/P1-S12-T04.md) |
| P1-S5-005 | pg_trgm similarity retrieval | [P1-S12-T04](tasks/P1-S12-T04.md) |
| P1-S5-006 | approved voice source resolver | [P1-S12-T05](tasks/P1-S12-T05.md) |
| P1-S5-007 | repository terminology/statistics profile | [P1-S12-T05](tasks/P1-S12-T05.md) |
| P1-S5-008 | optional embedding interface + pgvector implementation | [P1-S18-T02](tasks/P1-S18-T02.md) |
| P1-S5-009 | context-budget/ranking builder | [P1-S08-T02](tasks/P1-S08-T02.md), [P1-S12-T06](tasks/P1-S12-T06.md) |
| P1-S6-001 | provider-neutral ModelProvider contracts | [P1-S04-T01](tasks/P1-S04-T01.md) |
| P1-S6-002 | canonical Zod -> JSON Schema conversion | [P1-S04-T01](tasks/P1-S04-T01.md) |
| P1-S6-003 | OpenAI adapter | [P1-S04-T03](tasks/P1-S04-T03.md) |
| P1-S6-004 | Gemini auth-key adapter | [P1-S04-T04](tasks/P1-S04-T04.md) |
| P1-S6-005 | OpenRouter adapter | [P1-S04-T05](tasks/P1-S04-T05.md) |
| P1-S6-006 | provider error normalization / retry policy | [P1-S04-T02](tasks/P1-S04-T02.md) |
| P1-S6-007 | Test Connection capability probe | [P1-S04-T07](tasks/P1-S04-T07.md) |
| P1-S6-008 | encrypted provider credential APIs | [P1-S16-T03](tasks/P1-S16-T03.md) |
| P1-S7-001 | runner enrollment token flow | [P1-S07-T02](tasks/P1-S07-T02.md) |
| P1-S7-002 | runner credential auth + heartbeat | [P1-S07-T02](tasks/P1-S07-T02.md) |
| P1-S7-003 | job lease API | [P1-S07-T03](tasks/P1-S07-T03.md) |
| P1-S7-004 | scoped read-only GitHub token issuance for runner | [P1-S07-T04](tasks/P1-S07-T04.md) |
| P1-S7-005 | runner ephemeral checkout/extraction pipeline | [P1-S08-T06](tasks/P1-S08-T06.md), [P1-S15-T01](tasks/P1-S15-T01.md) |
| P1-S7-006 | Ollama adapter using native structured outputs | [P1-S04-T06](tasks/P1-S04-T06.md) |
| P1-S7-007 | Ollama model/capability test | [P1-S04-T06](tasks/P1-S04-T06.md) |
| P1-S7-008 | optional Ollama embedding adapter | [P1-S18-T01](tasks/P1-S18-T01.md) |
| P1-S7-009 | normalized result upload + control-plane validation | [P1-S07-T05](tasks/P1-S07-T05.md), [P1-S15-T02](tasks/P1-S15-T02.md) |
| P1-S7-010 | Docker image + deployment documentation | [P1-S15-T03](tasks/P1-S15-T03.md) |
| P1-S8-001 | deterministic content rule engine | [P1-S08-T03](tasks/P1-S08-T03.md) |
| P1-S8-002 | review router | [P1-S08-T03](tasks/P1-S08-T03.md) |
| P1-S8-003 | reviewer prompt/schema | [P1-S08-T04](tasks/P1-S08-T04.md), [P1-S13-T01](tasks/P1-S13-T01.md) |
| P1-S8-004 | candidate evidence validator | [P1-S08-T04](tasks/P1-S08-T04.md), [P1-S13-T01](tasks/P1-S13-T01.md) |
| P1-S8-005 | verifier prompt/schema | [P1-S08-T04](tasks/P1-S08-T04.md), [P1-S13-T02](tasks/P1-S13-T02.md) |
| P1-S8-006 | bounded one-step context expansion | [P1-S13-T03](tasks/P1-S13-T03.md) |
| P1-S8-007 | scoring/ranking | [P1-S13-T04](tasks/P1-S13-T04.md) |
| P1-S8-008 | dedupe/grouping | [P1-S13-T04](tasks/P1-S13-T04.md) |
| P1-S8-009 | subjective comment budget | [P1-S13-T05](tasks/P1-S13-T05.md) |
| P1-S8-010 | review summary generator | [P1-S13-T05](tasks/P1-S13-T05.md) |
| P1-S9-001 | parser-specific replacement encoders | [P1-S11-T01](tasks/P1-S11-T01.md) |
| P1-S9-002 | placeholder preservation validator | [P1-S11-T02](tasks/P1-S11-T02.md) |
| P1-S9-003 | in-memory reparse validation | [P1-S11-T03](tasks/P1-S11-T03.md) |
| P1-S9-004 | diff-range suggestion eligibility | [P1-S11-T04](tasks/P1-S11-T04.md) |
| P1-S9-005 | GitHub suggestion-block renderer | [P1-S11-T04](tasks/P1-S11-T04.md) |
| P1-S9-006 | stale-head prepublish guard | [P1-S14-T01](tasks/P1-S14-T01.md) |
| P1-S9-007 | grouped review publish + summary upsert | [P1-S14-T02](tasks/P1-S14-T02.md) |
| P1-S9-008 | check conclusion policy | [P1-S14-T03](tasks/P1-S14-T03.md) |
| P1-S10-001 | GitHub-based dashboard auth/session | [P1-S16-T01](tasks/P1-S16-T01.md) |
| P1-S10-002 | installation/repository settings UI | [P1-S16-T02](tasks/P1-S16-T02.md) |
| P1-S10-003 | provider credential/model UI | [P1-S16-T04](tasks/P1-S16-T04.md) |
| P1-S10-004 | runner registration/status UI | [P1-S16-T05](tasks/P1-S16-T05.md) |
| P1-S10-005 | `.humanize.yml` schema/validator/loader | [P1-S08-T01](tasks/P1-S08-T01.md) |
| P1-S10-006 | configuration precedence resolver | [P1-S08-T01](tasks/P1-S08-T01.md) |
| P1-S10-007 | explicit learnings UI/API | [P1-S17-T01](tasks/P1-S17-T01.md) |
| P1-S10-008 | review history/diagnostics | [P1-S17-T03](tasks/P1-S17-T03.md) |
| P1-S10-009 | retention mode setting | [P1-S17-T04](tasks/P1-S17-T04.md) |
| P1-S11-001 | OpenTelemetry traces + Pino redaction | [P1-S01-T05](tasks/P1-S01-T05.md), [P1-S19-T01](tasks/P1-S19-T01.md) |
| P1-S11-002 | operational metrics | [P1-S19-T01](tasks/P1-S19-T01.md) |
| P1-S11-003 | extraction gold suite threshold gates | [P1-S10-T04](tasks/P1-S10-T04.md), [P1-S19-T04](tasks/P1-S19-T04.md) |
| P1-S11-004 | review gold suite | [P1-S08-T05](tasks/P1-S08-T05.md), [P1-S19-T04](tasks/P1-S19-T04.md) |
| P1-S11-005 | provider contract CI | [P1-S04-T07](tasks/P1-S04-T07.md), [P1-S19-T04](tasks/P1-S19-T04.md) |
| P1-S11-006 | GitHub end-to-end test repo | [P1-S14-T04](tasks/P1-S14-T04.md) |
| P1-S11-007 | duplicate/reordered webhook stress test | [P1-S05-T06](tasks/P1-S05-T06.md), [P1-S14-T04](tasks/P1-S14-T04.md) |
| P1-S11-008 | large repository/resource-limit test | [P1-S19-T03](tasks/P1-S19-T03.md) |
| P1-S11-009 | prompt-injection test corpus | [P1-S19-T02](tasks/P1-S19-T02.md) |
| P1-S11-010 | secret scanning/security review | [P1-S19-T02](tasks/P1-S19-T02.md) |
| P1-S11-011 | database backup/restore runbook | [P1-S20-T01](tasks/P1-S20-T01.md) |
| P1-S11-012 | incident/runner/provider failure runbooks | [P1-S15-T04](tasks/P1-S15-T04.md), [P1-S20-T02](tasks/P1-S20-T02.md) |
