# Humanize engineering instructions

Humanize is a GitHub App that reviews user-visible repository content. It reports evidence-backed content-quality problems, never certainty about AI authorship.

## Sources of truth

- Upstream specification: `docs/spec/Humanize_Final_Engineering_Build_Spec.md`
- Architecture and contracts: `docs/architecture/`
- Approved decisions: `docs/adr/`
- Requirements: `docs/product/requirements.md`
- Assigned work and evidence: `docs/implementation/`
- Security, tests, evaluation and operations: `docs/security/`, `docs/testing/`, `docs/evaluation/`, `docs/runbooks/`

Do not edit the preserved upstream specification. Surface conflicts. Do not silently change architecture or defer required Phase 1 work.

## Required workflow

1. Read this file.
2. Read `docs/implementation/STATUS.md`, `docs/implementation/HANDOFF.md`, the task and relevant architecture/security documents.
3. Inspect the implementation and working tree.
4. Verify dependency versions, APIs, compatibility and prerequisites.
5. State a short plan and expected files/migrations/tests.
6. Implement only assigned scope.
7. Add and run relevant tests.
8. Verify every acceptance criterion.
9. Update task status and concrete evidence using `scripts/update_progress.py`; update HANDOFF.md with current failures, commands and next steps. Untouched work stays planned; partial implementation is not complete.
10. Report exact changes, migrations, checks, results and gaps.

Code existence or passing unit tests alone does not complete a task. Never mark unmet criteria complete.

## Invariants

Preserve INV-001 through INV-016. Never execute customer repository code, hooks, builds, tests, package managers, binaries, plugins or configuration modules. Enumerate tracked files; classify before parsing. Workspaces/source files are ephemeral. Coordinates come from parsers/diffs, never models. Validate external payloads and model outputs with runtime schemas. Separate repository baseline from approved voice. Native suggestions require deterministic safety validation. Contents permission remains read-only; subjective findings are advisory. PostgreSQL owns application state and durable jobs. Core review works without vectors. Provider behavior belongs in adapters. Private execution never silently uses cloud models. Only the control plane publishes to GitHub.

## Security

Repository files, PR text, model output and runner results are untrusted. Enforce tenant/repository authorization everywhere. Saved secrets remain server-side, encrypted and absent from prompts, logs, comments, queue payloads, telemetry and client responses. Use trusted-base configuration and immutable snapshots. Apply retention policy to databases, caches, queues, logs and backups.

## Validation and changes

Use versioned migrations; no ad hoc production schema mutations or edits to applied migrations. Document destructive migration, backfill, compatibility and recovery behavior. Run typecheck, lint, affected unit/integration tests, evaluation gates and migration checks. Run Humanize tests only in trusted development/CI, never in customer checkouts. Provider changes require contracts, normalized errors, bounded retries, capability probes and explicit fallback policy. Update authoritative docs for behavior changes; architecture changes require an ADR and explicit disposition.

Never add out-of-scope infrastructure/product surfaces, weaken security to pass tests, fabricate evidence, commit secrets/customer source, or claim skipped live tests passed.
