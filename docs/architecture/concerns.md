# Architecture concerns and dispositions

All dispositions below were accepted in the approved execution plan; the preserved source has not been modified.

## AC-01: Failed webhook recovery

Current design: Normal reviews are webhook-triggered. GitHub does not automatically redeliver failures.

Consequence: Without recovery, outages permanently lose reviews.

Accepted change and impact: Permit scheduled failed-delivery recovery, not repository polling. Persist recovery cursors and deduplicate replay. See [ADR-021](../adr/ADR-021.md).

## AC-02: Publication freshness

Current design: GitHub offers no atomic compare-head-and-publish.

Consequence: A transient old-head comment may be visible; never describe it as current.

Accepted change and impact: Pin reviews/checks to SHA, check before and after, and mark raced output obsolete. See [ADR-022](../adr/ADR-022.md).

## AC-03: Ambiguous external writes

Current design: PostgreSQL cannot transact atomically with GitHub.

Consequence: Timeout after acceptance otherwise duplicates comments.

Accepted change and impact: Use stable markers, serialized publication attempts and reconciliation. Never blindly retry uncertain writes. See [ADR-023](../adr/ADR-023.md).

## AC-04: Ephemeral lexical retrieval

Current design: Mandatory PostgreSQL search does not specify a runner database.

Consequence: Avoid unnecessary customer PostgreSQL sidecars.

Accepted change and impact: Use in-memory lexical/trigram retrieval for ephemeral jobs and PostgreSQL for indexed cloud mode behind one port. See [ADR-024](../adr/ADR-024.md).

## AC-05: Retention-safe results

Current design: Persistent findings/evidence can contain source text.

Consequence: Queue bodies and diagnostics can otherwise violate privacy.

Accepted change and impact: Ephemeral mode persists metadata only. Result handoffs stay in memory; regenerate after loss following reconciliation. See [ADR-025](../adr/ADR-025.md).

## AC-06: Runner result trust

Current design: Local validation alone is not independent validation.

Consequence: A compromised runner must not fabricate published evidence.

Accepted change and impact: Control plane transiently reads exact GitHub source and revalidates evidence/ranges/patches without cloud model calls. See [ADR-026](../adr/ADR-026.md).

## AC-07: Trusted configuration

Current design: The specification does not choose the configuration revision.

Consequence: A PR must not weaken its own review or exfiltrate content.

Accepted change and impact: Use trusted PR base configuration. Provider, retention, execution and endpoint choices are administrator-only. See [ADR-027](../adr/ADR-027.md).

## AC-08: Organization authorization

Current design: Installing the App does not prove organization ownership.

Consequence: Repository admins cannot otherwise safely control organization policy.

Accepted change and impact: Require fresh admin access to every enabled repository for organization-wide writes, at least one enabled repository, and serialized enablement checks. See [ADR-028](../adr/ADR-028.md).

## AC-09: Coordinate semantics

Current design: Parser offsets and decoded text differ across formats.

Consequence: Unicode, entities and discontinuous prose otherwise create wrong fixes.

Accepted change and impact: Use half-open UTF-16 offsets, one-based lines and explicit visible/source segment mappings. See [ADR-029](../adr/ADR-029.md).

## AC-10: Structural suggestion proof

Current design: Successful parsing alone does not prove safe replacement.

Consequence: Valid syntax can still inject expressions or attributes.

Accepted change and impact: Encode text/value only and require unchanged surrounding syntax structure after reparsing. See [ADR-030](../adr/ADR-030.md).

## AC-11: Ollama local-only inference

Current design: A local Ollama endpoint can expose cloud features.

Consequence: Localhost is not sufficient evidence of private inference.

Accepted change and impact: Require local-only server configuration and local model capability checks; reject cloud-backed models. See [ADR-031](../adr/ADR-031.md).

## AC-12: Feedback provenance

Current design: GitHub events do not prove all user intentions.

Consequence: Mislabeling outcomes poisons evaluation.

Accepted change and impact: Separate explicit feedback from conservative inferred outcomes; never infer confirmed acceptance or permanent policy. See [ADR-032](../adr/ADR-032.md).

## AC-13: Risk-ordered execution

Current design: The source roadmap introduces evaluation/configuration/telemetry late.

Consequence: Late discovery of core assumptions wastes implementation effort.

Accepted change and impact: Execute the approved 21-stage roadmap while preserving every upstream task mapping. See [ADR-033](../adr/ADR-033.md).

## AC-14: Optional vector delivery

Current design: Optional runtime features could be mistaken for optional implementation.

Consequence: Core functionality must remain independent of vectors.

Accepted change and impact: Deliver capability-gated embeddings/pgvector in Phase 1, default off, separate migrations. See [ADR-034](../adr/ADR-034.md).

## AC-15: Credential ingress

Current design: A dashboard form necessarily receives newly entered credentials.

Consequence: An overly literal restriction would prevent the required credential UI.

Accepted change and impact: Allow one-way secret submission, never saved-secret readback, browser storage, analytics, bundling or browser provider calls. See [ADR-035](../adr/ADR-035.md).
