# Adversarial security review

Each boundary below was attacked with the corpus in `packages/testing`, executed against the
real components by `evals/security/boundaries.test.ts` rather than against doubles. Attacks
that succeeded are recorded as findings with what was changed; limits that remain are stated
rather than glossed.

Reviewed on 2026-09-18 against the working tree. This is an agent review, not an independent
audit; P1-S19-T02 is not satisfied until a human security reviewer has repeated it.

## Prompt injection through repository content

Eight attack shapes were tried: direct instruction override, role reassignment, closing the
content boundary, imitating a system turn, credential exfiltration, requesting shell access,
inviting the forbidden authorship claim, and injection hidden in an `alt` attribute where a
reader never looks.

**Held.** Content is fenced with a per-review unguessable marker, any occurrence of that
marker inside the content is stripped so content cannot close its own fence, and the policy
is stated before any content is shown. Independently, a model that *did* obey an injection
still publishes nothing, because the deterministic gate refuses any quotation absent from the
reviewed node. Both layers were tested separately, so neither is load-bearing alone.

## Fabricated evidence

A compromised model or runner returning an invented quotation, a file path outside the
repository, or a traversal path.

**Held.** A candidate is discarded unless it names the reviewed node, quotes text genuinely
present in it, cites only supplied evidence, and stays within the routed categories. The
control plane repeats the quotation check when rebuilding findings from an accepted runner
result, so passing upload validation is not enough to be published.

## Unsafe patches

Replacements that parse cleanly yet change what a file does: opening a JSX expression,
injecting an element, escaping an HTML attribute to add an event handler, and dropping a
placeholder the surrounding code depends on.

**Held.** Each is refused or neutralised by encoding, and the structural proof re-parses the
modified file and rejects anything that differs from the original in more than the target
text. A replacement that loses a placeholder never publishes.

## Parser hostility

Deep nesting, unterminated markup, a YAML alias bomb, a single enormous line, twenty thousand
nodes in one file, and embedded null bytes.

**Finding, fixed.** Twenty thousand nodes in one file took **10.9 seconds** to extract. The
file was well within the size cap, so nothing stopped it consuming a job's time budget; the
size limit did not imply a node limit. Extraction now stops at `LIMITS.nodesPerFile` and
reports `NODE_LIMIT_REACHED`, because a partially reviewed file must not look like a fully
reviewed one. The same corpus now completes in **1.2 seconds**.

## Secret leakage into telemetry

Credential-shaped values passed through both unexpected and allowlisted log fields.

**Finding, fixed.** The redaction allowlist filtered by field *name*, so a value in an
expected field passed through verbatim: a connection string logged as `event`, or a token as
`traceId`, was written in full. Values are now scrubbed by shape wherever they appear —
URLs carrying a password, authorization headers, GitHub and provider keys, and long opaque
tokens — while ordinary operational values such as `PARSE_FAILURE` are untouched.

**Residual limit, accepted and recorded.** Scrubbing works on shape. An arbitrary short
opaque secret is indistinguishable from an ordinary operational value and cannot be caught
this way. The field allowlist and scrubbing are backstops; callers must still not log
secrets. A high-entropy secret is caught, a short low-entropy one is not.

## Tenant isolation

Cross-organization access was attempted against every store and endpoint that takes an
organization: credentials, repositories, policy, learnings, feedback, runners, leases,
lease tokens and result upload.

**Held.** Each refuses, and the refusals happen before the underlying store is called rather
than after. Composite foreign keys carry the tenant through every dependent row, so a
mismatched pair is rejected by the database as well as by the application.

## What this review does not cover

- No live GitHub or cloud provider was involved, so nothing here tests real token scope,
  real webhook delivery, or a real provider's handling of hostile content.
- No dependency vulnerability scan, image scan, SBOM or signing (P1-S20).
- No authenticated penetration testing of the dashboard, which has no UI yet.
- Denial of service is bounded per file and per node, but there is no global rate limit on
  unauthenticated registration attempts or webhook volume.
