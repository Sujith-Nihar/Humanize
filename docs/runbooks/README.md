# Operational readiness

Reference deployment is Linux containers for dashboard/API/publisher/workers plus PostgreSQL and separate self-hosted runners; TLS and secrets are deployment-managed. No Redis, Kafka or Kubernetes requirement. Live deployment and drills are not complete until recorded in task evidence.

Release procedures must test graceful shutdown, versioned migrations, expand/migrate/contract compatibility, previous-version rollback, encrypted backup/restore, and GitHub reconciliation after restore. Target RPO <=15 minutes, RTO <=4 hours; seven-day encrypted backup expiry. Alert on oldest queued review >5 minutes, runner offline/lease failures and publication ambiguity. Logs retain 14 days without source.

Incident paths: recover missed webhook deliveries using App API and durable dedupe; reconcile uncertain publish before retry; cancel/revoke compromised runner; rotate provider/encryption credentials; diagnose provider failure without raw prompts; purge retention-scoped intelligence after opt-out/removal. Second-operator execution is required evidence in P1-S20.
