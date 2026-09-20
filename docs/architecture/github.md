# GitHub lifecycle and publication

Permissions: Metadata read, Contents read, Pull requests write, Checks write. No Contents write or organization Members permission. Separate read-only acquisition tokens from control-plane publication credentials; never put tokens in URLs, durable jobs or process arguments.

Verify raw-body HMAC before parsing/effects. Commit delivery metadata and job atomically, then acknowledge. Target p95 under two seconds. Deduplicate delivery IDs and semantic repository/PR/head identities. Debounce synchronize events five seconds; reconcile current GitHub state instead of trusting delivery order. Installation suspension/removal and repository removal stop access and invalidate leases. Handle open/synchronize/reopen/ready, closed/draft cancellation and base changes. Failed-delivery recovery is permitted; normal repository polling is not.

Fetch fork heads through installed base-repository PR refs, never arbitrary fork URLs with installation credentials. Compute local merge-base-to-head diffs; validate GitHub-representable RIGHT-side geometry. Re-review new changed nodes and affected prior findings, suppress unchanged fingerprints.

Only COMMENT reviews. Pin reviews/checks to SHA, check before and after writes. Stable run markers and durable publication attempts reconcile uncertain outcomes before retry. A raced review is obsolete, never current. Use grouped review bodies for summaries and same-run updates, no issue permission assumption.

Check precedence: configured deterministic blocking violations fail; advisory/incomplete/config/provider diagnostics neutral; complete clean review success; superseded work cancelled. GitHub offers no atomic head-compare-and-publish or documented review-create idempotency key. Fail closed on ambiguity.

References: [reviews](https://docs.github.com/en/rest/pulls/reviews), [webhook recovery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
