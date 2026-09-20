# Humanize

Humanize is a GitHub App for evidence-backed review of user-visible repository content. It detects generic wording, clarity, terminology, style and claim issues without asserting AI authorship. Cloud providers are OpenAI, Gemini and OpenRouter; local Ollama runs through the outbound-only Humanize Runner. Ephemeral retention is the default.

**Status:** implementation in progress. Start with [implementation status](docs/implementation/STATUS.md) and [agent handoff](docs/implementation/HANDOFF.md) to see implemented work, remaining tasks, verification failures and exact next steps. Production readiness requires every stage's acceptance evidence, live-service checks and independent human evaluation. See the [roadmap](docs/implementation/README.md) and [upstream task crosswalk](docs/implementation/crosswalk.md).

## Engineering documentation

- [Agent instructions](AGENTS.md)
- [Preserved specification and checksum](docs/spec/README.md)
- [Requirements and invariants](docs/product/requirements.md)
- [Architecture](docs/architecture/README.md), [decisions](docs/adr/README.md)
- [Security](docs/security/README.md), [testing](docs/testing/README.md), [evaluation](docs/evaluation/README.md)
- [Operations](docs/runbooks/README.md)

## Development

Use Node.js 22.23.2 or compatible supported Node 22/24 and the pinned pnpm version in package.json. Run `pnpm install`, `pnpm check`, and start the disposable PostgreSQL service with `docker compose up -d postgres`. Never use production credentials or customer checkouts as development fixtures. Service-specific startup instructions are added with the relevant implementation.
