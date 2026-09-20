# Test strategy

Run `pnpm check` for documentation, package boundaries, typecheck, lint and unit tests. PostgreSQL integration tests require a disposable HUMANIZE_TEST_DATABASE_URL. Live GitHub/provider/Ollama tests require dedicated test resources and are explicitly gated, never counted as passing when absent. Playwright covers dashboard flows only. Humanize development tests never run in customer checkouts.

Layer fixtures into pure/domain, parser gold, real PostgreSQL, provider contracts, fake GitHub interleavings, live test-App lifecycle, runner failures, dashboard E2E, security and operational drills. Cover success and failure plus authorization/retry/cancellation/concurrency wherever relevant. Store redacted artifacts with tool/model/schema versions. Do not commit secrets or customer source.

Live services run in their own lane: `pnpm test:live` matches `*.live.test.ts` and is excluded from the default and integration lanes, so `pnpm check` never depends on a running service. A live test throws rather than skipping when its service variables are absent, so an unavailable service is reported as blocked and never counted as passing. Live coverage is currently Ollama only; OpenAI, Gemini and OpenRouter have never been contacted.
