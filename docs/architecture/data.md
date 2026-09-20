# Data lifecycle

PostgreSQL is authoritative for Humanize operational state, never repository source. Customer-owned records carry organization_id; repository-owned records also carry repository_id. Composite foreign keys enforce scope. Users are global identities, joined through tenant memberships.

Persistent: installations, repositories, config versions, encrypted credential references, model profiles, webhook tombstones, PR/run states, publication attempts/remote IDs, runner identity/leases, explicit learnings, feedback and administration audit metadata.

Derived and rebuildable, indexed mode only: ContentNodes/versions/relations, lexical indexes, baseline statistics, blob extraction cache and optional versioned embeddings. Activate generations atomically; older/failed scans cannot replace newer successful generations.

Ephemeral: full files, Git objects/workspaces, ASTs, PR bodies, prompts/context, raw model output, plaintext credentials/tokens and result handoffs. Never write these to durable queue payloads. Ephemeral mode is default: findings/evidence retain only metadata/IDs/hashes/ranges, not quotes/replacements/explanations. An in-memory result lost before publication is regenerated only after reconciling remote effects.

Review details expire after 30 days; logs after 14 days. Compact dedupe tombstones live for the installation lifetime and open-PR fingerprints survive detail expiry. Indexed caches/old generations are bounded; active generation is retained. Encrypted backups expire after seven days. Privacy-mode transitions cancel incompatible jobs and purge derived/content-bearing data; backup lag is disclosed. Removal stops access immediately and schedules scoped deletion.

Migrations are immutable and versioned. Use expand/migrate/contract with compatibility and recovery evidence; optional vector migrations never run on the core path. pg-boss uses a separate schema. Application state and enqueue share one node-postgres transaction; external calls never run inside long DB transactions.
