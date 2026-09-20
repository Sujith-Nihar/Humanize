# Humanize (Working Name)
## Final Engineering Build Specification

**Product type:** GitHub App for repository-aware content review  
**Document purpose:** Authoritative implementation plan for Claude Code, Codex, or a human engineering team  
**Status:** Final architecture for Phase 1 build  
**Date:** 17 September 2026  
**Phase policy:** Phase 1 must be a complete, production-ready software product. Phase 2 is restricted to fixes, tuning, compatibility, reliability, security, and scaling improvements.

> **Primary product statement**  
> Humanize is a GitHub App that is installed on repositories, enumerates every tracked file, extracts only user-visible content, reviews changed content in pull requests, flags high-confidence AI-like/generic writing and content-quality problems, and posts evidence-based GitHub review comments with safe one-click suggestions.

> **Important interpretation**  
> Humanize does **not** claim to prove whether a human or AI authored text. The product detects review-worthy *AI-like/generic writing patterns* and other content quality issues. That distinction is intentional and non-negotiable.

---

# 1. How to use this specification with Claude Code or Codex

This document is the source of truth. An implementation agent must not treat it as loose brainstorming.

Before writing code, the agent must:

1. Read the complete specification.
2. Inspect the existing repository, if one exists.
3. Produce a stage-by-stage implementation plan mapped to the requirement IDs and task IDs in this document.
4. Identify conflicts between the existing repository and this architecture.
5. Preserve existing conventions where they do not violate a non-negotiable invariant.
6. Implement one stage at a time.
7. Run the required tests and acceptance checks after every stage.
8. Report changed files, migrations, tests, and remaining gaps.
9. Never silently skip a requirement because it appears difficult.
10. If a design change is necessary, write an Architecture Decision Record explaining the reason before changing the architecture.

The implementation agent must **not** independently add payment systems, browser extensions, VS Code extensions, runtime website crawling, graph databases, autonomous branch-writing, code execution from customer repositories, or extra agent swarms. Those are outside Phase 1.

---

# 2. Product definition

Humanize is a repository-aware review system for content shipped inside software products.

It is conceptually similar to a code-review bot in workflow, but its target is the text end users read rather than software behavior.

Humanize must understand content in places such as:

- React and Next.js JSX/TSX
- JavaScript/TypeScript UI strings that are confidently user-visible
- HTML
- Markdown and MDX
- Vue templates
- Svelte templates
- JSON/YAML localization resources
- CSS generated content where the value is statically user-visible
- buttons, headings, labels, placeholders, alt text, ARIA labels, errors, notifications, tooltips, descriptions, metadata, documentation, marketing copy, and other supported human-facing strings

The product workflow is:

```text
Install GitHub App
        |
        v
Initial default-branch repository scan
        |
        v
Build repository content baseline
        |
Developer opens or updates PR
        |
        v
Compute exact changed files and lines
        |
        v
Extract changed user-visible ContentNodes
        |
        v
Build relevant repository + organization context
        |
        v
Rules + reviewer model
        |
        v
Candidate findings
        |
        v
Independent verification + deterministic evidence validation
        |
        v
Rank + deduplicate + noise budget
        |
        v
GitHub summary + inline comments + safe suggestions
        |
Developer applies suggestion or pushes new commit
        |
        v
Incremental re-review
```

## 2.1 Core review categories

Phase 1 must support:

1. **AI-like / generic wording** — low-information or formulaic language that reads as machine-generated or generic, without asserting authorship.
2. **Clarity and verbosity** — content that is unnecessarily long, vague, awkward, or difficult to understand.
3. **Repository style deviation** — wording that strongly differs from established repository language.
4. **Approved voice mismatch** — only when approved voice examples/rules have been explicitly configured.
5. **Terminology mismatch** — inconsistent product names, capitalization, preferred terms, or prohibited terms.
6. **Repetition / near-duplication** — repeated marketing or documentation content.
7. **Potential claim inconsistency** — content that may conflict with related repository content.
8. **Potential unsupported claim** — absolute or risky statements that have no supporting evidence in configured repository context.

## 2.2 What Humanize is not

Humanize is not:

- a binary AI-authorship detector
- a plagiarism detector
- a generic grammar checker
- a code-quality reviewer
- a GitHub Action as the primary integration
- a system that executes customer code
- a crawler that renders production websites in Phase 1
- a system that automatically rewrites branches without user approval
- a graph-database project
- a custom foundation-model training project

---

# 3. Final architecture decisions

The following decisions have been re-evaluated against GitHub's current platform behavior, publicly described CodeRabbit architecture patterns, current provider APIs, local-model networking, and production failure modes.

| ID | Decision | Final choice | Why |
|---|---|---|---|
| ADR-001 | Primary integration | GitHub App | GitHub Apps provide installation-scoped access, webhooks, PR review APIs, and Checks API integration. |
| ADR-002 | Primary execution trigger | Webhooks, never polling | Lower latency, lower GitHub rate-limit usage, and correct event-driven behavior. |
| ADR-003 | Repository execution | Never execute repository code | The product only needs static source analysis; avoiding installs/builds/scripts drastically reduces security risk. |
| ADR-004 | Repository storage | Ephemeral checkout only | Source of truth remains GitHub. No persistent copy of full repositories. |
| ADR-005 | Database | PostgreSQL | Needed for installation state, repo configuration, review runs, findings, jobs, runner state, and optional derived content intelligence. |
| ADR-006 | Queue | PostgreSQL-backed durable queue | Avoids Redis as an unnecessary Phase 1 dependency; jobs remain durable and transactional with product state. |
| ADR-007 | Vector search | Optional pgvector accelerator | Core review must work with full-text/trigram retrieval. Semantic retrieval is useful but cannot be a hard dependency. |
| ADR-008 | Content relationships | Relational tables, not graph DB | Content relationships are much simpler than program control/data-flow relationships. |
| ADR-009 | AI detector | No binary authorship verdict | Real-world detection is probabilistic and vulnerable to domain/style shifts. Humanize reviews content quality and AI-like patterns instead. |
| ADR-010 | Review architecture | Hybrid reviewer + verifier | Mirrors the useful CodeRabbit pattern: deterministic context, candidate generation, verification, ranking, and noise suppression. |
| ADR-011 | Agent architecture | No agent swarm | Five or ten independent agents per string would add latency, cost, disagreement, and debugging complexity without proven value. |
| ADR-012 | Model providers | Provider-neutral abstraction | OpenAI, Gemini, OpenRouter, and Ollama must use one normalized request/result contract. |
| ADR-013 | Local Ollama | Self-hosted Humanize Runner | A cloud GitHub App cannot directly call a user's localhost. The runner executes inside the customer's network. |
| ADR-014 | Provider fallback | Never silently cross providers | Local/private content must never unexpectedly be sent to a cloud provider. |
| ADR-015 | Voice learning | Approved voice != repository baseline | Existing repository content may itself be poor; it cannot automatically be treated as approved brand voice. |
| ADR-016 | GitHub fixes | Native suggestion blocks first | Safe one-click changes without requesting repository contents-write permission. |
| ADR-017 | Merge blocking | Advisory by default | Subjective AI-style findings must not block merges unless customers explicitly configure deterministic policies. |
| ADR-018 | Runtime crawling | Not Phase 1 | Preview auth, CMS, dynamic routes, browser isolation, and route discovery add large complexity unrelated to proving the core product. |
| ADR-019 | Fine-tuning | Not Phase 1 | Context, extraction, verification, and evaluation are higher-value engineering work initially. |
| ADR-020 | Product name | Humanize is a working name | Keep code modular enough to permit a later brand rename; public name clearance is separate from product architecture. |

---

# 4. Non-negotiable system invariants

These are implementation constraints, not suggestions.

- **INV-001** Humanize must never execute scripts, package managers, builds, tests, binaries, or hooks from customer repositories.
- **INV-002** Humanize must never persist a complete repository checkout after a job finishes.
- **INV-003** Repository content is untrusted data and must never be interpreted as system instructions.
- **INV-004** Every published inline finding must map to a real file path and source range validated deterministically.
- **INV-005** Every one-click suggestion must pass a parser-specific safety check before publication.
- **INV-006** Humanize must never claim certainty that content was authored by AI.
- **INV-007** Humanize must never silently switch from Ollama/private execution to a cloud model.
- **INV-008** Provider secrets must never appear in logs, PR comments, prompts, client-side JavaScript, or repository configuration.
- **INV-009** Duplicate GitHub webhook delivery must not create duplicate reviews or comments.
- **INV-010** Findings generated for a stale PR head SHA must never be published as current findings.
- **INV-011** The GitHub App must not require Contents write permission in Phase 1.
- **INV-012** A repository baseline must not be treated as approved brand voice unless explicitly configured as an approved source.
- **INV-013** No model response may be trusted without schema validation.
- **INV-014** A model-generated line number may never be used as the source of truth for GitHub line mapping.
- **INV-015** The system must remain functional if semantic embeddings are disabled.
- **INV-016** Humanize must enumerate every tracked file in scope, even though many files will be deterministically classified as non-content and skipped without LLM processing.

---

# 5. Production architecture

```text
                               GITHUB
                                  |
                         Webhooks / App APIs
                                  |
                     +------------v-------------+
                     | Humanize API / Webhook   |
                     | Control Plane            |
                     +------------+-------------+
                                  |
                    verify -> dedupe -> enqueue
                                  |
                           PostgreSQL
                     state + pg-boss jobs
                                  |
                        +---------+----------+
                        |                    |
                        v                    v
                 Cloud Worker         Self-hosted Runner
                        |                    |
                 Ephemeral repo        Ephemeral repo
                    checkout              checkout
                        |                    |
                 Extract + index       Extract + index
                        |                    |
                 Context + review      Context + review
                        |                    |
          OpenAI / Gemini / OpenRouter      Ollama
                        |                    |
                        +---------+----------+
                                  |
                         Normalized findings
                                  |
                        deterministic verify
                                  |
                           rank + dedupe
                                  |
                         GitHub publisher
                    summary / comments / check
```

## 5.1 Control plane

The control plane owns:

- GitHub App identity/private key
- webhook ingestion and signature verification
- installation/repository registration
- dashboard authentication
- repository and organization configuration
- encrypted cloud-provider credentials
- durable job orchestration
- review-run state machine
- runner registration and job leasing
- GitHub publishing
- review history and diagnostics
- explicit learnings and feedback

## 5.2 Execution plane

The execution plane owns:

- repository checkout
- file enumeration/classification
- parsing and extraction
- source mapping
- baseline/index creation
- context retrieval
- rule execution
- model calls
- reviewer and verifier execution
- suggestion construction and parser validation

Cloud jobs run in cloud workers. Ollama/private jobs run in the self-hosted runner.

---

# 6. Recommended technology stack

The stack is intentionally conservative and TypeScript-first.

| Area | Technology |
|---|---|
| Runtime | Node.js LTS + TypeScript strict mode |
| Monorepo | pnpm workspaces |
| Dashboard | Next.js |
| API/webhooks | Fastify |
| Database | PostgreSQL |
| ORM/migrations | Drizzle ORM + drizzle-kit |
| Durable jobs | pg-boss |
| Runtime schemas | Zod |
| GitHub SDK | Octokit |
| Logging | Pino |
| Tracing/metrics | OpenTelemetry |
| Unit/integration tests | Vitest |
| Browser E2E for dashboard only | Playwright |
| TS/JS/JSX/TSX parsing | @babel/parser + @babel/traverse |
| Markdown/MDX | unified + remark-parse + remark-mdx |
| HTML | parse5 |
| Vue | @vue/compiler-sfc + @vue/compiler-dom |
| Svelte | svelte/compiler |
| CSS generated content | postcss |
| YAML | yaml |
| JSON | native parser plus source-location parser |
| Git | git CLI in a restricted process wrapper |
| Local model | Ollama native API from self-hosted runner |

Do not introduce Redis, Kafka, Kubernetes, Neo4j, Elasticsearch, or a separate vector database in Phase 1 unless a measured production limitation makes it unavoidable.

---

# 7. Monorepo layout

```text
humanize/
  apps/
    dashboard/          # Next.js configuration and diagnostics UI
    api/                # Fastify API + GitHub webhooks + runner endpoints
    worker/             # cloud durable-job worker
    runner/             # self-hosted runner for Ollama/private execution

  packages/
    domain/             # shared domain types and state machines
    db/                 # Drizzle schema, migrations, repositories
    queue/              # pg-boss wrapper and typed jobs
    github/             # GitHub App auth, tokens, diffs, publisher
    config/             # .humanize.yml + org/repo config resolution
    scanner/            # repository enumeration and file classifier
    extractors/         # parser-specific ContentNode extraction
    content-index/      # baseline/index management
    retrieval/          # local context, FTS, trigram, optional vector
    rules/              # deterministic content rules
    review/             # router, reviewer, verifier, ranking, dedupe
    providers/          # OpenAI/Gemini/OpenRouter/Ollama adapters
    suggestions/        # parser-safe one-click replacement generation
    security/           # secrets, prompt-injection boundaries, token scopes
    telemetry/          # logs, traces, metrics
    testing/            # fixtures, fake GitHub, provider contract harness
    shared/             # small shared utilities only

  evals/
    extraction/
    review/
    provider-contracts/
    end-to-end/

  docs/
    architecture/
    runbooks/
    adr/

  docker/
    runner/

  .humanize.yml.example
  AGENTS.md
  CLAUDE.md
```

The `AGENTS.md` and `CLAUDE.md` files should summarize the invariants and point back to this specification.

---

# 8. GitHub App design

## 8.1 Required repository permissions

Request the minimum permissions necessary:

| Permission | Level | Reason |
|---|---:|---|
| Metadata | Read | Basic repository identity; implicit for GitHub Apps. |
| Contents | Read | Clone/read repository content and baseline files. |
| Pull requests | Write | Read PRs and publish grouped reviews / inline review comments. |
| Checks | Write | Create and update `Humanize / Content Review` check runs. |

Do not request Contents write, Administration, Issues, Actions, Secrets, or organization-wide Members permissions in Phase 1.

## 8.2 Webhook subscriptions

Subscribe only to required events:

- `installation`
- `installation_repositories`
- `pull_request`
- `push`
- `check_run` for explicit re-run/requested actions if implemented

Review these `pull_request` actions by default:

- `opened`
- `synchronize`
- `reopened`
- `ready_for_review`

Draft PRs are skipped unless `.humanize.yml` or organization settings enable draft reviews.

## 8.3 Webhook security

**SEC-GH-001** Validate the raw request body with the configured webhook secret and `X-Hub-Signature-256` before JSON parsing or side effects.

**SEC-GH-002** Use `X-GitHub-Delivery` as a durable idempotency key.

**SEC-GH-003** Return quickly after verification, durable event recording, and enqueueing; expensive work runs asynchronously.

## 8.4 Installation tokens

- Mint installation access tokens server-side from the GitHub App private key.
- Tokens expire after one hour; cache only until shortly before expiry.
- When possible, scope each token to a single repository and reduced permissions.
- Cloud review workers receive a read-only repository token.
- Self-hosted runners receive a single-repository, read-only token only for the leased job.
- GitHub publishing remains in the control plane and uses a separate appropriately scoped token.

## 8.5 Review publication policy

Humanize submits review feedback as `COMMENT`, not `APPROVE` or `REQUEST_CHANGES`.

The Check Run policy is:

- `success`: no configured blocking deterministic policy violation
- `neutral`: advisory AI-like/voice/clarity findings exist
- `failure`: only when the customer explicitly configured a deterministic blocking rule and it is violated

Subjective AI-like language alone must never fail the check by default.

---

# 9. Dashboard and authentication

Phase 1 needs a small but real dashboard because hosted-provider credentials and runner configuration cannot safely live in repository files.

The dashboard must provide:

- GitHub sign-in / authorization
- list of installations and repositories the user can administer
- repository enable/disable controls
- provider configuration
- review model and verifier model selection
- optional embedding model selection
- Test Connection action
- self-hosted runner registration and health
- repository configuration status
- review history and failure diagnostics
- explicit learnings/rules management
- privacy/retention mode

Provider keys are write-only after save. The UI may display provider name, masked identifier, creation timestamp, and last successful connection test, but never return the secret.

---

# 10. Repository acquisition and sandboxing

## 10.1 Cloud worker checkout

For a job:

1. Create an empty temporary workspace with a random identifier.
2. Obtain a single-repository installation token.
3. Clone/fetch only the required repository and commits.
4. Set `GIT_LFS_SKIP_SMUDGE=1`.
5. Do not initialize submodules.
6. Do not run package managers.
7. Do not run repository binaries/scripts.
8. Do not load environment files from the repository.
9. After the job, recursively delete the checkout even on failure.

The git wrapper must expose only required commands such as `clone`, `fetch`, `checkout`, `diff`, `ls-files`, `show`, and `rev-parse`.

## 10.2 What “scan every file” means

Humanize must enumerate every tracked path with `git ls-files` (or equivalent) at the reviewed commit.

Each path is then assigned one deterministic classification:

```text
SUPPORTED_CONTENT
POSSIBLE_CONTENT
NON_CONTENT_SOURCE
GENERATED
DEPENDENCY
BINARY
TOO_LARGE
IGNORED_BY_CONFIG
UNKNOWN
```

Only relevant text files are parsed. Non-content files do not consume LLM tokens.

This preserves the product promise that the repository is comprehensively inspected without doing wasteful or dangerous work.

## 10.3 Default exclusions

Default path rules should exclude or de-prioritize:

- `.git/**`
- `node_modules/**`
- `vendor/**`
- build/dist/cache directories
- coverage output
- lock files
- minified bundles
- source maps
- binary assets
- generated code detected by standard markers

A customer can override include/exclude patterns but cannot override hard security restrictions.

---

# 11. Content extraction engine

The extraction engine is the highest-priority deterministic component in the product. Review quality cannot compensate for bad extraction.

## 11.1 Normalized ContentNode

```ts
export interface ContentNode {
  id: string;
  repositoryId: string;
  commitSha: string;

  filePath: string;
  blobSha: string;
  parser: string;
  parserVersion: string;

  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;

  text: string;
  normalizedText: string;

  kind:
    | 'heading'
    | 'paragraph'
    | 'button'
    | 'link'
    | 'label'
    | 'placeholder'
    | 'tooltip'
    | 'error'
    | 'notification'
    | 'documentation'
    | 'marketing'
    | 'metadata'
    | 'accessibility'
    | 'css_generated'
    | 'unknown';

  sourceKind: string;
  component?: string;
  structuralPath?: string;
  locale?: string;
  dynamic: boolean;
  visibilityConfidence: number;

  placeholders: string[];
  quoteStyle?: 'single' | 'double' | 'template' | 'none';
  stableKey: string;
}
```

`startLine`, `endLine`, and offsets always come from parsers/source maps, never from the LLM.

## 11.2 TS/JS/JSX/TSX extraction

Use Babel AST parsing.

High-confidence extraction includes:

- `JSXText`
- static string literal or static template literal used as JSX children
- static visible JSX attributes such as `title`, `alt`, `placeholder`, `aria-label`, `label`, `description`, `helperText`, `caption`, `tooltip`
- configured custom visible props
- configured/built-in high-confidence UI calls such as toast/error notification functions

Ignore by default:

- endpoints
- database keys
- identifiers
- internal statuses
- log strings
- test descriptions
- config keys
- arbitrary string literals with no user-visible semantic evidence

Example:

```tsx
const endpoint = '/api/users';        // ignore
const status = 'active';             // ignore

<h1>Manage your AI applications</h1> // extract
<Input placeholder="Work email" />  // extract

toast('Changes saved');              // extract when recognized as a UI API
```

## 11.3 HTML

Use `parse5` with source-location tracking.

Extract:

- rendered text nodes
- visible/accessibility attributes
- metadata configured as user-facing

Skip scripts, styles, templates that are not rendered, and known machine/config attributes.

## 11.4 Markdown and MDX

Use unified/remark ASTs.

Extract:

- headings
- paragraphs
- list text
- table text
- link labels
- blockquotes when appropriate

Skip:

- fenced code
- inline code where prose review would be misleading
- MDX expressions
- frontmatter unless a configured field is customer-visible

Complex Markdown nodes with inline links/emphasis may be reviewed but should not receive an automatic replacement unless the suggestion patch can preserve the syntax safely.

## 11.5 Vue

Use Vue's official SFC/template parsers.

Extract static template text and visible static bindings. Do not attempt to execute computed properties.

## 11.6 Svelte

Use `svelte/compiler` AST. Extract static template text and attributes; mark unresolved dynamic values as dynamic.

## 11.7 JSON/YAML localization

Do not review every JSON/YAML string in a repository.

High-confidence locale sources are discovered through:

- conventional paths such as `locales`, `i18n`, `translations`, `messages`
- configured include globs
- references from detected translation calls where feasible

Values become ContentNodes. Keys are context, not prose.

## 11.8 CSS generated content

Use PostCSS to extract static `content: "..."` strings from pseudo-elements. Mark these as `css_generated`. They are user-visible but often poor for accessibility, so review conservatively.

## 11.9 Dynamic content

Examples:

```tsx
<h1>{product.title}</h1>
<h1>{t('hero.title')}</h1>
```

- Resolve translation keys when the target locale resource can be deterministically found.
- Resolve local compile-time constants when safe.
- Otherwise create a dynamic metadata node or skip prose review.
- Never execute application code to resolve dynamic values.

---

# 12. Visibility confidence and routing

Every extracted node receives a deterministic visibility confidence score.

Examples:

| Source | Typical confidence |
|---|---:|
| `<h1>Hello</h1>` | 1.00 |
| `placeholder="Enter email"` | 0.99 |
| `toast('Saved')` recognized via configured UI function | 0.95 |
| object property `message: 'Failed'` in known UI structure | 0.80 |
| arbitrary `const status = 'active'` | 0.05 |
| endpoint path | 0.00 |

Only nodes over the configured automatic-review threshold are eligible for LLM review.

All supported nodes may still be indexed for context if their semantic role is clear.

---

# 13. Baseline and incremental repository index

## 13.1 Initial scan

After installation or repository enablement:

1. identify default branch and current commit SHA
2. enumerate every tracked file
3. classify files
4. parse supported content files
5. normalize ContentNodes
6. compute deterministic fingerprints
7. build lexical search indexes
8. calculate repository baseline statistics
9. optionally generate semantic embeddings if configured
10. mark baseline scan ready

The product may review a PR while the baseline is still building, but must clearly mark reduced-context mode internally and use on-demand repository reads.

## 13.2 Default-branch updates

Subscribe to `push` events.

When the default branch advances:

- diff previous indexed SHA to new SHA
- invalidate changed blobs only
- reuse extraction for unchanged blob SHAs
- parse changed/new files
- remove deleted nodes
- update baseline transactionally

If the previous SHA is unavailable or the update is a force push that invalidates incremental assumptions, schedule a full rescan.

## 13.3 Blob cache

Cache parser output by:

```text
blob SHA + extractor version + relevant extraction config hash
```

This allows identical files to be reused across branches and scans.

---

# 14. Repository baseline vs approved voice

These are separate concepts.

## 14.1 Repository baseline

Derived automatically from default-branch content.

It answers:

- what terminology is common?
- what sentence length/style is typical?
- what related statements exist?
- does new content materially deviate from the rest of the repository?

It does **not** mean the existing content is good.

## 14.2 Approved voice

Approved voice comes only from explicit configuration:

- selected file/path sources
- manually supplied examples
- explicit style rules
- approved terminology

Example:

```yaml
voice:
  approved_sources:
    - app/(marketing)/page.tsx
    - docs/brand/**
  tone:
    - direct
    - technical
    - concise
  avoid:
    - cutting-edge
    - revolutionary
    - game-changing
```

If no approved sources exist, Humanize may report **repository style deviation**, but not a definitive brand-voice violation.

---

# 15. Retrieval and context engine

The context engine must be useful without vectors.

## 15.1 Mandatory retrieval

Use PostgreSQL full-text search and `pg_trgm` similarity for:

- exact terminology matches
- near-duplicate phrases
- similar strings
- repeated claims
- related headings and descriptions

Always include:

- changed node
- source kind and file path
- nearby nodes from same file/section/component
- PR title/body
- repository rules
- organization rules
- approved voice examples when configured
- relevant explicit learnings

## 15.2 Optional vector retrieval

If an embedding provider/model is configured and the deployment supports pgvector:

- embed baseline nodes in batches
- embed review query content
- retrieve semantically related nodes
- fuse vector results with lexical results

Vector retrieval is an accelerator, not the only retrieval method.

If embedding model/version changes, embeddings are versioned and re-indexed asynchronously. Never compare vectors from incompatible embedding spaces.

## 15.3 Context budget

The context builder ranks evidence and enforces a token budget. The goal is not to send the entire repository to the model.

Priority:

1. changed content
2. immediate local content
3. explicit rules / approved voice
4. strongest related repository evidence
5. lower-confidence baseline context

---

# 16. AI-like content detection philosophy

Humanize must optimize for useful review rather than authorship accusation.

Recent research continues to show that AI-detection behavior can vary significantly under domain/style shifts and paraphrasing. Therefore:

- Do not publish “93% AI generated.”
- Do not use a detector score as proof.
- Do not create blocking decisions from AI-likeness alone.
- Explain the observable writing problem.

Example:

```text
Instead of:
"This is 92% AI-generated."

Publish:
"Generic / AI-like wording: 'unlock unprecedented potential' and
'cutting-edge platform' are broad promotional phrases with little
product-specific information. Existing approved headlines use direct,
capability-focused wording."
```

## 16.1 Deterministic AI-style signals

Rules may emit evidence such as:

- known low-information promotional phrases
- repeated rhetorical constructions
- repetitive transitions
- excessive superlatives/adverbs
- unusually uniform sentence structures
- repeated sentence openings
- high repetition of generic modifiers
- organization-prohibited phrases

These are evidence signals, not an authorship classifier.

---

# 17. Review pipeline

The final Phase 1 review pipeline is hybrid and bounded.

```text
Changed ContentNodes
       |
       v
Deterministic rule pre-pass
       |
       v
Context Builder
       |
       v
Review Router
       |
       v
Primary Reviewer (structured output)
       |
       v
Candidate Findings
       |
       +-- deterministic evidence validation
       |
       v
Verifier (only where needed)
       |
       v
Score / Dedupe / Noise Budget
       |
       v
GitHub Publisher
```

## 17.1 Review routing

Do not apply every reviewer to every string.

Examples:

- a short button label may need clarity/terminology review but not a long-form generic-prose review
- a marketing paragraph should receive AI-like, clarity, voice, and claim routing
- a technical documentation paragraph may receive clarity, terminology, consistency, and claim routing
- accessibility labels should prioritize clarity and correctness

The router uses deterministic node metadata plus an inexpensive model classification only when necessary.

## 17.2 Reviewer output schema

```ts
export interface CandidateFinding {
  nodeId: string;
  category:
    | 'ai_like_generic'
    | 'clarity'
    | 'repository_style'
    | 'approved_voice'
    | 'terminology'
    | 'repetition'
    | 'claim_inconsistency'
    | 'unsupported_claim';

  severity: 'major' | 'minor' | 'nit';
  confidence: number;

  exactText: string;
  explanation: string;
  evidence: Array<{
    type: 'rule' | 'repo_content' | 'voice_example' | 'config';
    description: string;
    filePath?: string;
    line?: number;
    quote?: string;
  }>;

  replacement?: string;
  requiresVerification: boolean;
}
```

No model is allowed to return a source line number that becomes authoritative. Source positions are attached by the orchestrator using the node ID.

## 17.3 Verification

Verification is mandatory for:

- claim inconsistency
- unsupported claims
- voice findings that rely on repository evidence
- low-margin/high-impact AI-like findings
- any finding proposed as major when the primary reviewer confidence is not extremely high

The verifier receives the original candidate and evidence and returns:

```ts
interface VerificationResult {
  publish: boolean;
  confidence: number;
  correctedExplanation?: string;
  correctedReplacement?: string;
  reasonIfSuppressed?: string;
}
```

Use a separate model invocation even when reviewer and verifier are configured to the same model.

## 17.4 Bounded context expansion

To remain provider-neutral and predictable, Phase 1 does not use an unconstrained autonomous tool loop.

The reviewer may request at most one additional context expansion by returning structured search queries. The orchestrator executes read-only repository search and re-runs review with the expanded context.

This provides agentic investigation without an open-ended agent swarm.

---

# 18. Ranking, deduplication, and noise control

A content reviewer that posts dozens of weak comments will be uninstalled.

## 18.1 Ranking

A candidate score may combine:

```text
confidence
x severity weight
x evidence quality
x visibility confidence
x actionability
x novelty
```

The exact coefficients must be evaluation-driven rather than guessed permanently.

## 18.2 Deduplication

Merge findings when they:

- overlap the same source range
- identify the same generic phrase cluster
- make the same claim inconsistency argument
- propose essentially the same replacement

## 18.3 Default noise budget

Default behavior:

- maximum 5 subjective inline comments per PR
- deterministic critical policy violations are not limited by the subjective budget
- additional minor findings go to the summary
- nitpicks are off by default

Configuration may change these limits.

---

# 19. Safe one-click suggestions

GitHub suggestions are the Phase 1 autofix mechanism.

Humanize must not request Contents write permission merely to implement fixes.

## 19.1 Suggestion safety rules

A suggestion is published only if:

1. the target source range is deterministic
2. the range intersects the current PR's changed lines
3. the full replacement range is representable in the GitHub diff
4. all placeholders/variables are preserved
5. the parser-specific replacement encoder succeeds
6. the modified in-memory file re-parses successfully
7. the PR head SHA is still current

If any check fails, publish the explanation without a one-click suggestion.

## 19.2 Placeholder preservation

For content such as:

```text
Hello {name}
You have {{count}} alerts
%s files processed
```

The placeholder multiset before and after replacement must be identical unless an explicit rule allows a change.

## 19.3 Source-specific patching

- JSX text: replace text span only
- JSX/string attributes: preserve/escape quote style
- JS/TS string literals: safely re-encode quotes and escapes
- HTML attributes/text: preserve valid syntax
- JSON: re-encode JSON string value only
- YAML: preserve scalar validity
- simple Markdown/MDX nodes: replace node text only
- complex MDX/ICU/dynamic expressions: comment-only unless a dedicated validator proves the change safe

---

# 20. Multi-provider model architecture

Humanize must not embed provider-specific logic inside the review engine.

## 20.1 Provider interface

```ts
export interface ModelProvider {
  readonly id: 'openai' | 'gemini' | 'openrouter' | 'ollama';

  testConnection(config: ProviderConfig): Promise<ProviderCapabilities>;
  listModels?(config: ProviderConfig): Promise<ModelDescriptor[]>;

  generateStructured<T>(args: {
    model: string;
    system: string;
    input: string;
    schema: ZodType<T>;
    timeoutMs: number;
    traceContext: TraceContext;
  }): Promise<ModelResult<T>>;

  embed?(args: EmbedRequest): Promise<EmbedResult>;
}
```

The review engine knows only this interface.

## 20.2 Provider roles

Configuration supports independent roles:

```yaml
models:
  reviewer:
    provider: openrouter
    model: some-model

  verifier:
    provider: openai
    model: some-model

  embeddings:
    enabled: false
```

Reviewer and verifier may use the same provider/model but remain separate calls.

## 20.3 OpenAI adapter

Requirements:

- server-side credential only
- use current OpenAI Responses/structured-output capability
- convert canonical Zod schema to provider-supported JSON schema
- validate the parsed result again locally with Zod
- log request IDs and metadata, never prompts or API keys by default
- retry retryable transport/rate-limit errors with bounded exponential backoff

## 20.4 Gemini adapter

As of this specification's date, use Gemini **authorization API keys**, not legacy standard keys.

Requirements:

- use the official Google GenAI SDK or documented REST API
- use structured output with a supported JSON schema
- validate again locally with Zod
- provider key remains server-side
- normalize provider-specific safety/refusal/limit errors

## 20.5 OpenRouter adapter

Even though OpenRouter is OpenAI-compatible, implement it as a separate adapter.

Reasons:

- model/provider routing is OpenRouter-specific
- feature support varies by model/provider endpoint
- structured-output support must be verified
- OpenRouter-specific headers and diagnostics are useful

Connection testing must verify that the selected model can satisfy the required structured-output schema. When supported, require provider routing that honors the requested parameters rather than silently choosing an endpoint that lacks them.

## 20.6 Ollama adapter

Local Ollama must run through the self-hosted runner.

Use the native Ollama API for maximum control:

```text
http://localhost:11434/api/chat
```

For structured output, send the JSON Schema in Ollama's `format` field and validate the returned JSON locally.

Embeddings, when enabled, may use:

```text
POST /api/embed
```

Do not assume every installed model is good enough for review merely because it can generate text.

## 20.7 Provider capability test

`Test Connection` must run a real compatibility check:

1. authenticate/reach provider
2. verify selected model exists or is callable
3. ask it to return a tiny canonical structured schema
4. validate the response
5. measure response time
6. record supported capabilities

A model that cannot reliably satisfy the schema is marked incompatible with automated PR review.

## 20.8 Fallback policy

- transport retries may stay within the same provider/model
- optional fallback to another model/provider must be explicitly configured by an administrator
- Ollama/private mode defaults to **no fallback**
- under no condition may a local job silently send content to OpenAI, Gemini, or OpenRouter

---

# 21. Self-hosted Humanize Runner for Ollama

This is required because the Humanize cloud service cannot access a customer's localhost.

## 21.1 Deployment

Ship a Docker image and documented binary/container configuration.

Typical environment:

```text
HUMANIZE_CONTROL_PLANE_URL=https://humanize.example.com
HUMANIZE_RUNNER_TOKEN=...
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

The runner initiates all network connections outbound. It does not require customers to expose Ollama publicly.

## 21.2 Registration

1. Admin creates a one-time runner enrollment token from the dashboard.
2. Token expires quickly and is single-use.
3. Runner registers and receives a revocable runner credential.
4. Credential is stored locally with restrictive file permissions or container secret mechanisms.
5. Control plane records runner ID, organization, labels, capabilities, last heartbeat, and status.

## 21.3 Job lease protocol

Runner polls or long-polls a lease endpoint.

A lease includes:

- review job ID
- repository identity
- PR/base/head SHA metadata
- immutable configuration snapshot
- temporary single-repository read-only GitHub installation token
- lease expiry

The lease does **not** contain a cloud provider credential.

## 21.4 Runner execution

Runner:

1. validates lease
2. creates ephemeral workspace
3. clones/fetches repository directly from GitHub
4. runs the same scanner/extractors/retrieval/review packages as cloud worker
5. calls local Ollama
6. performs local validation and suggestion safety checks
7. returns normalized findings and diagnostics
8. destroys workspace

The control plane performs final stale-SHA checks and publishes to GitHub.

## 21.5 Why publishing stays in the control plane

The runner receives only read-only repository access. It does not need Pull Requests write permission or long-lived GitHub credentials.

This keeps the most privileged GitHub operations centralized and auditable.

---

# 22. PostgreSQL: what it is for and what it is not for

PostgreSQL remains a required system component even when long-term content memory is disabled.

It is required for ordinary application state:

- GitHub installations
- organizations/users
- repositories
- provider configuration references
- review runs and state transitions
- webhook idempotency
- check/comment IDs
- durable jobs
- runner registrations and leases
- explicit rules/learnings
- review feedback

PostgreSQL is **not** required because “AI needs memory.”

## 22.1 Mandatory operational tables

```text
users
organizations
organization_members
github_installations
repositories
repository_configs
provider_credentials
model_profiles
webhook_deliveries
pull_requests
review_runs
findings
finding_evidence
published_comments
explicit_learnings
feedback
runners
runner_leases
baseline_scans
```

`pg-boss` owns its queue tables separately.

## 22.2 Optional derived content tables

In indexed mode:

```text
content_nodes
content_node_versions
content_relations
content_embeddings
blob_extraction_cache
```

These are rebuildable derived data. GitHub remains the source of truth.

## 22.3 No raw repository storage

Do not persist:

- complete source files
- zipped repositories
- checkout directories
- arbitrary repository archives
- raw ASTs after jobs unless explicitly justified as compact derived metadata

## 22.4 Retention modes

### Indexed mode

Persist normalized ContentNodes and optional embeddings for faster, richer repository-aware review.

### Ephemeral/privacy mode

Persist only operational state, explicit configuration, and explicit learnings. Rebuild repository content context per review and delete it after the job.

Both modes must work through the same review interfaces.

---

# 23. Durable job orchestration

Use `pg-boss` behind a typed `JobQueue` abstraction.

Job types:

```text
repository.initial_scan
repository.incremental_scan
pull_request.review
review.cloud_execute
review.runner_wait
review.publish
runner.cleanup
maintenance.reindex
```

Each job must have:

- schema-validated payload
- idempotency key
- retry policy
- timeout
- dead-letter/final-failure handling
- trace ID
- repository/organization identity

## 23.1 Debouncing synchronize events

Developers often push multiple commits quickly.

For the same repository + PR:

- coalesce review work around the newest head SHA
- old queued reviews may be cancelled/superseded
- workers must re-check current head before expensive model work when possible
- publisher must always re-check current head before posting

## 23.2 Review state machine

```text
RECEIVED
  -> QUEUED
  -> ACQUIRING_REPO
  -> EXTRACTING
  -> BUILDING_CONTEXT
  -> REVIEWING
  -> VERIFYING
  -> READY_TO_PUBLISH
  -> PUBLISHING
  -> COMPLETE

alternate terminal/intermediate states:
STALE
CANCELLED
FAILED_RETRYABLE
FAILED_FINAL
```

Transitions must be explicit and persisted.

---

# 24. Configuration model

Repository configuration file:

```text
.humanize.yml
```

Example:

```yaml
version: 1

review:
  drafts: false
  categories:
    ai_like_generic: true
    clarity: true
    repository_style: true
    approved_voice: true
    terminology: true
    repetition: true
    claim_inconsistency: true
    unsupported_claim: true

comments:
  max_subjective_inline: 5
  minimum_severity: minor

include:
  - "app/**"
  - "components/**"
  - "docs/**"
  - "locales/**"

exclude:
  - "**/*.test.*"
  - "**/*.stories.*"
  - "dist/**"

visible_props:
  - headline
  - subheadline
  - helperText

visible_calls:
  - toast
  - notify

voice:
  approved_sources:
    - "docs/brand/**"
  tone:
    - direct
    - concise
  avoid:
    - cutting-edge
    - revolutionary

terminology:
  prefer:
    "AI tool": "AI application"

blocking_rules:
  - type: forbidden_phrase
    phrase: "100% secure"
```

## 24.1 Configuration precedence

Highest to lowest:

1. hard system/security invariants
2. organization administration policy
3. repository `.humanize.yml`
4. path-specific repository config
5. explicit learnings/preferences
6. product defaults

Repository files may never weaken security invariants or provider secret handling.

---

# 25. Learnings and feedback

Phase 1 supports explicit project knowledge without uncontrolled automatic memory.

## 25.1 Explicit learning

Example:

```text
Scope: docs/developer/**
Rule: "AI tool" is approved terminology in developer documentation.
```

Learnings can be:

- created through dashboard
- created through an explicit future review interaction if implemented
- edited
- disabled
- deleted

## 25.2 Feedback

Record outcomes such as:

```text
accepted_suggestion
dismissed
manual_fix
false_positive
intentional_wording
resolved_by_new_commit
outdated
```

Feedback improves evaluation and later ranking, but a single dismissal must **not** automatically become a permanent rule.

---

# 26. Security model

## 26.1 Threat assumptions

Treat all repository content as attacker-controlled input.

Potential attacks include:

- prompt injection in source files or docs
- huge files / parser bombs
- crafted syntax that crashes parsers
- API key exfiltration attempts
- malicious URLs
- webhook replay
- cross-tenant access mistakes
- runner credential theft
- model output attempting unauthorized actions

## 26.2 Prompt-injection boundary

Repository content is wrapped as untrusted evidence.

The model never receives GitHub tokens, provider credentials, database credentials, or arbitrary shell tools.

If bounded context expansion is used, the model may only request structured read-only searches. The orchestrator owns tool execution.

## 26.3 Provider secrets

Implement a `SecretStore` abstraction.

Default hosted implementation:

- encrypt credentials at rest with authenticated encryption
- store only ciphertext + key version + metadata in PostgreSQL
- root/master encryption key comes from deployment secret management, never the database
- support rotation
- never return a saved secret to the browser
- scrub authorization headers and credential-like values from logs/errors

## 26.4 Network policy

Cloud-provider adapters use fixed allowlisted provider endpoints.

Do not allow arbitrary customer-configured cloud base URLs in Phase 1 because that creates SSRF risk.

The self-hosted runner may use a configured Ollama URL inside the customer's network.

## 26.5 Tenant isolation

Every customer-owned database record must carry `organization_id`; repository-owned records additionally carry `repository_id`.

Authorization is enforced server-side for every dashboard/API operation.

## 26.6 Resource limits

Enforce:

- maximum parseable file size
- maximum PR changed-file count per batch with graceful chunking
- maximum node text length
- maximum model context budget
- parser timeouts
- model timeouts
- runner job timeout

Large repositories must degrade gracefully rather than crash the service.

---

# 27. Observability

Use OpenTelemetry traces plus structured Pino logs.

## 27.1 Operational metrics

Track:

- webhook validation/ingest latency
- queue wait time
- checkout duration
- scan/extraction duration
- number of tracked/classified/parsed files
- extracted ContentNodes by type/parser
- context retrieval latency
- model latency by provider/model/role
- verifier suppression rate
- GitHub publication latency
- job retry/failure rate
- stale review count
- runner online/offline state

## 27.2 Product quality metrics

Track:

- inline findings per PR
- findings by category/severity
- suggestions offered
- suggestions accepted
- findings dismissed/false-positive feedback
- duplicate suppression count
- reviewer -> verifier rejection rate

## 27.3 Logging policy

Do not log full prompts/source content by default.

Logs should use IDs, counts, hashes, paths where safe, provider/model identifiers, durations, and error classes.

A secure debug mode may be explicitly enabled in non-production environments.

---

# 28. Evaluation system

The evaluation harness is a first-class product component, not post-launch polish.

## 28.1 Extraction benchmark

Maintain hundreds of fixtures across supported syntaxes.

Each fixture labels:

```text
expected visible strings
content kind
source range
visibility confidence expectation
expected ignored strings
expected placeholders
safe suggestion eligibility
```

Initial release targets for supported high-confidence constructs:

- extraction precision >= 98%
- extraction recall >= 90%
- exact source-range accuracy >= 99%
- parser-safe one-click suggestion validation = 100% in fixture suite

## 28.2 Review benchmark

Create a human-labeled corpus containing:

- strong human-authored copy
- mediocre human copy
- raw LLM-generated copy
- edited/mixed AI-assisted copy
- technical docs
- marketing pages
- UI microcopy
- localization strings
- legitimate promotional language that should **not** be flagged
- intentional deviations from repository baseline
- real and false cross-file inconsistencies

Labels:

```text
should_comment
category
severity
evidence
acceptable_rewrite_or_direction
```

Optimize primarily for **precision of inline comments**, not maximum recall.

Initial release target: >= 80% of major inline findings in the internal gold set are judged useful/correct by independent human review.

## 28.3 Provider contract suite

Run the same structured-output tests against:

- OpenAI adapter
- Gemini adapter
- representative OpenRouter models that claim required capability
- representative local Ollama models

A provider/model configuration must pass contract tests before being recommended for production use.

## 28.4 End-to-end GitHub test repository

Automated or semi-automated test flow:

1. install test GitHub App
2. initial scan
3. open fixture PR
4. receive webhook
5. create Check Run
6. review changed visible content
7. post exact-line comment
8. publish a safe suggestion
9. push a follow-up commit
10. ensure stale comment behavior is correct
11. ensure incremental review processes only new changes
12. verify duplicate webhook delivery creates no duplicate comments

---

# 29. Reliability and failure behavior

## 29.1 Partial parser failure

A malformed or unsupported file must not fail the whole PR review.

Record parser failure, continue remaining files, and surface an internal diagnostic.

## 29.2 Model failure

- retry retryable transport errors with bounded backoff
- one structured-output repair retry is allowed
- no unbounded retry loops
- no cross-provider fallback unless explicitly configured
- if review cannot complete, update the Check Run with a clear neutral/failure diagnostic depending on cause; do not fabricate findings

## 29.3 Baseline unavailable

Review can fall back to:

- changed file content
- nearby source content
- explicit rules/voice
- on-demand lexical search against temporary repository extraction

It must not silently pretend full repository context was available.

## 29.4 GitHub rate limits

- cache installation tokens
- use webhooks instead of polling
- batch review comments into grouped reviews
- use conditional requests where helpful
- obey retry/reset headers
- avoid one API call per extracted string

---

# 30. Phase 1 implementation plan

Phase 1 is complete only after all stages reach their exit criteria.

## Stage P1-S0 — Repository and engineering foundation

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S0-001 | Create pnpm TypeScript monorepo and package boundaries | none | clean install, typecheck passes |
| P1-S0-002 | Add shared Zod domain contracts | 001 | contract tests pass |
| P1-S0-003 | Add lint/format/typecheck/test CI | 001 | CI green on clean PR |
| P1-S0-004 | Add Docker Compose local Postgres | 001 | local bootstrap documented and tested |
| P1-S0-005 | Add ADR template and architecture docs | 001 | ADR directory and initial decisions present |
| P1-S0-006 | Add AGENTS.md and CLAUDE.md with non-negotiable invariants | 005 | both files reference spec and invariants |

**Exit:** a clean monorepo that agents can extend without circular dependencies.

## Stage P1-S1 — PostgreSQL, queue, and control-plane primitives

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S1-001 | Drizzle schema for organizations/users/installations/repos/config | S0 | migrations apply/rollback in test DB |
| P1-S1-002 | Review-run, finding, webhook-delivery schemas | 001 | uniqueness/idempotency tests |
| P1-S1-003 | Runner and lease schemas | 001 | lease lifecycle tests |
| P1-S1-004 | SecretStore abstraction and encrypted Postgres implementation | 001 | ciphertext only; rotation test |
| P1-S1-005 | pg-boss typed JobQueue wrapper | 001 | retry/idempotency/dead-letter tests |
| P1-S1-006 | Review state-machine service | 002 | invalid transitions rejected |

**Exit:** durable state and jobs survive process restarts and duplicate delivery attempts.

## Stage P1-S2 — GitHub App control plane

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S2-001 | GitHub App JWT + installation token service | S1 | integration test with GitHub test app |
| P1-S2-002 | raw-body webhook signature verification | 001 | official test vectors + tamper tests |
| P1-S2-003 | webhook idempotency using delivery GUID | 002 | same delivery twice -> one job |
| P1-S2-004 | installation / repository event handlers | 003 | DB state matches fixture payloads |
| P1-S2-005 | pull_request event router | 003 | only configured actions enqueue |
| P1-S2-006 | push handler for default-branch index updates | 003 | correct incremental scan job produced |
| P1-S2-007 | Check Run create/update service | 001 | test repo shows check lifecycle |
| P1-S2-008 | PR review publisher and summary upsert | 001 | grouped review posts successfully |

**Exit:** GitHub App can install, receive secure events, enqueue work, and publish a placeholder review/check.

## Stage P1-S3 — Repository acquisition and file scanner

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S3-001 | restricted git process wrapper | S2 | command allowlist tests |
| P1-S3-002 | ephemeral workspace lifecycle | 001 | cleanup on success/error/cancel |
| P1-S3-003 | read-only clone/fetch by scoped installation token | 001 | private test repo checkout succeeds |
| P1-S3-004 | enumerate every tracked file | 003 | fixture repo path count matches git |
| P1-S3-005 | deterministic file classifier | 004 | classifier fixture corpus |
| P1-S3-006 | path/size/binary/generated exclusion engine | 005 | boundary tests |
| P1-S3-007 | local diff + changed-line map | 003 | exact RIGHT-side line mappings verified |

**Exit:** Humanize can safely understand repository structure and PR changed-line geometry without executing repo code.

## Stage P1-S4 — Content extraction engine

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S4-001 | ContentNode domain + stable-key/fingerprint | S3 | deterministic snapshot tests |
| P1-S4-002 | Babel TS/JS/JSX/TSX extractor | 001 | high-confidence fixture suite |
| P1-S4-003 | HTML extractor | 001 | source-range fixtures |
| P1-S4-004 | Markdown/MDX extractor | 001 | code fences excluded |
| P1-S4-005 | Vue extractor | 001 | official-parser fixtures |
| P1-S4-006 | Svelte extractor | 001 | official-parser fixtures |
| P1-S4-007 | JSON/YAML locale extractor | 001 | locale/non-locale discrimination tests |
| P1-S4-008 | CSS generated-content extractor | 001 | PostCSS fixtures |
| P1-S4-009 | visible-prop / visible-call configurable rules | 002 | config override tests |
| P1-S4-010 | placeholder extraction and preservation metadata | 002-008 | ICU/handlebar/printf fixtures |
| P1-S4-011 | extraction benchmark runner | all | metrics report generated in CI |

**Exit:** supported user-visible content is extracted with exact deterministic locations and high precision.

## Stage P1-S5 — Baseline, index, and retrieval

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S5-001 | baseline scan persistence | S4 | full scan transaction tests |
| P1-S5-002 | blob extraction cache | 001 | unchanged blobs reused |
| P1-S5-003 | incremental default-branch update | 001-002 | only changed files reprocessed |
| P1-S5-004 | Postgres FTS index | 001 | retrieval fixtures |
| P1-S5-005 | pg_trgm similarity retrieval | 004 | near-duplicate fixtures |
| P1-S5-006 | approved voice source resolver | 001 | baseline and approved voice remain separate |
| P1-S5-007 | repository terminology/statistics profile | 001 | stable profile snapshot |
| P1-S5-008 | optional embedding interface + pgvector implementation | 004 | feature flag off still passes full suite |
| P1-S5-009 | context-budget/ranking builder | 004-008 | deterministic context snapshot tests |

**Exit:** review can retrieve strong context without requiring vectors.

## Stage P1-S6 — Hosted model providers

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S6-001 | provider-neutral ModelProvider contracts | S0 | fake provider contract tests |
| P1-S6-002 | canonical Zod -> JSON Schema conversion | 001 | schema fixtures |
| P1-S6-003 | OpenAI adapter | 001-002 | live gated integration test |
| P1-S6-004 | Gemini auth-key adapter | 001-002 | live gated integration test |
| P1-S6-005 | OpenRouter adapter | 001-002 | live gated integration test |
| P1-S6-006 | provider error normalization / retry policy | 003-005 | fault injection tests |
| P1-S6-007 | Test Connection capability probe | 003-006 | incompatible model rejected |
| P1-S6-008 | encrypted provider credential APIs | S1 + 003-005 | key never returned after save |

**Exit:** all hosted providers satisfy the same structured-output contract.

## Stage P1-S7 — Self-hosted runner and Ollama

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S7-001 | runner enrollment token flow | S1 | single-use/expiry tests |
| P1-S7-002 | runner credential auth + heartbeat | 001 | revoke/offline tests |
| P1-S7-003 | job lease API | 002 | lease expiry/reclaim tests |
| P1-S7-004 | scoped read-only GitHub token issuance for runner | S2 + 003 | token scope verified |
| P1-S7-005 | runner ephemeral checkout/extraction pipeline | S3-S4 + 003 | private repo runner E2E |
| P1-S7-006 | Ollama adapter using native structured outputs | S6 contracts | schema contract test |
| P1-S7-007 | Ollama model/capability test | 006 | bad model rejected |
| P1-S7-008 | optional Ollama embedding adapter | 006 | embedding contract test |
| P1-S7-009 | normalized result upload + control-plane validation | 003 | stale/mismatched job rejected |
| P1-S7-010 | Docker image + deployment documentation | all | clean-host install test |

**Exit:** a private repo can be reviewed end-to-end using local Ollama without exposing Ollama publicly and without sending source content to a cloud model.

## Stage P1-S8 — Review engine

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S8-001 | deterministic content rule engine | S4 | rule fixtures |
| P1-S8-002 | review router | 001 | routing snapshot tests |
| P1-S8-003 | reviewer prompt/schema | S5-S6 | gold dataset smoke test |
| P1-S8-004 | candidate evidence validator | 003 | fabricated quote/path suppressed |
| P1-S8-005 | verifier prompt/schema | 003 | known false candidate suppressed |
| P1-S8-006 | bounded one-step context expansion | S5 + 003 | tool budget enforced |
| P1-S8-007 | scoring/ranking | 004-005 | deterministic ranking tests |
| P1-S8-008 | dedupe/grouping | 007 | duplicate fixture merged |
| P1-S8-009 | subjective comment budget | 007-008 | max-inline behavior tests |
| P1-S8-010 | review summary generator | 007-009 | summary snapshot |

**Exit:** high-confidence, evidence-backed candidate reviews emerge with controlled noise.

## Stage P1-S9 — Suggestions and GitHub publishing

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S9-001 | parser-specific replacement encoders | S4 | quoting/escaping fixtures |
| P1-S9-002 | placeholder preservation validator | 001 | placeholder-loss always blocked |
| P1-S9-003 | in-memory reparse validation | 001 | invalid patch blocked |
| P1-S9-004 | diff-range suggestion eligibility | S3 + 001 | only changed ranges eligible |
| P1-S9-005 | GitHub suggestion-block renderer | 004 | suggestion applies in test repo |
| P1-S9-006 | stale-head prepublish guard | S2 | stale finding never posts |
| P1-S9-007 | grouped review publish + summary upsert | S2 + S8 | one review/no duplicate summaries |
| P1-S9-008 | check conclusion policy | S2 + S8 | subjective findings stay neutral |

**Exit:** developers receive clean GitHub-native review feedback and safe one-click changes.

## Stage P1-S10 — Dashboard and configuration

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S10-001 | GitHub-based dashboard auth/session | S2 | unauthorized tenant access blocked |
| P1-S10-002 | installation/repository settings UI | 001 | repo state configurable |
| P1-S10-003 | provider credential/model UI | S6 | save/test/rotate path |
| P1-S10-004 | runner registration/status UI | S7 | online/offline/revoke works |
| P1-S10-005 | `.humanize.yml` schema/validator/loader | S4 | invalid config clearly reported |
| P1-S10-006 | configuration precedence resolver | 005 | precedence fixtures |
| P1-S10-007 | explicit learnings UI/API | S1 | CRUD + scope auth tests |
| P1-S10-008 | review history/diagnostics | S8-S9 | failed run diagnosable without source dump |
| P1-S10-009 | retention mode setting | S5 | indexed/ephemeral tests |

**Exit:** administrators can operate the product without editing database records or server environment manually.

## Stage P1-S11 — Evaluation, observability, security, and GA hardening

| Task | Work | Depends on | Acceptance evidence |
|---|---|---|---|
| P1-S11-001 | OpenTelemetry traces + Pino redaction | all core | no secret/source leakage in log tests |
| P1-S11-002 | operational metrics | 001 | dashboard/metrics scrape works |
| P1-S11-003 | extraction gold suite threshold gates | S4 | CI fails below target |
| P1-S11-004 | review gold suite | S8 | precision report reproducible |
| P1-S11-005 | provider contract CI | S6-S7 | adapter regressions caught |
| P1-S11-006 | GitHub end-to-end test repo | S9 | complete PR lifecycle passes |
| P1-S11-007 | duplicate/reordered webhook stress test | S2 | no duplicate publication |
| P1-S11-008 | large repository/resource-limit test | S3-S5 | graceful degradation verified |
| P1-S11-009 | prompt-injection test corpus | S8 | instructions in repo cannot alter control policy |
| P1-S11-010 | secret scanning/security review | all | documented findings resolved |
| P1-S11-011 | database backup/restore runbook | S1 | restore drill passes |
| P1-S11-012 | incident/runner/provider failure runbooks | all | runbooks reviewed |

**Exit:** Phase 1 is production-ready.

---

# 31. Phase 1 final Definition of Done

Do not call Phase 1 complete until all of the following are true:

## GitHub product

- GitHub App installs on selected private/public repositories.
- Required permissions are limited to Contents read, Pull Requests write, Checks write, and metadata.
- Webhook HMAC validation is deployed.
- Duplicate webhook delivery is idempotent.
- Pull request open/update/reopen/ready events trigger review correctly.
- Default-branch push updates baseline.
- Check Runs and grouped PR reviews work reliably.

## Repository understanding

- Every tracked file is enumerated and classified.
- No customer code is executed.
- Supported parsers meet extraction thresholds.
- exact source ranges are deterministic.
- repository clones are deleted after jobs.

## Review quality

- AI-like findings are framed as content-quality observations, never definitive authorship claims.
- evidence comes from real rules/config/repository content.
- verification suppresses weak/unsupported findings.
- comment budget and deduplication work.
- repository baseline is distinct from approved voice.

## Fixes

- one-click suggestions work for safe source types.
- placeholder preservation is enforced.
- reparse validation prevents syntax-breaking suggestions.
- unsafe cases fall back to comment-only.

## Providers

- OpenAI works through provider contract.
- Gemini works with current auth-key requirements.
- OpenRouter verifies structured-output support for selected models.
- local Ollama works via self-hosted runner.
- no silent provider fallback exists.
- credentials are encrypted and never exposed to browser/logs.

## Operations

- Postgres migrations are repeatable and backed up.
- durable jobs recover after process restart.
- stale SHAs never publish current findings.
- logs/traces are redacted.
- runner credentials can be revoked.
- provider outages degrade safely.
- indexed and ephemeral retention modes both work.

## Testing

- extraction gold suite meets release thresholds.
- provider contract suite passes.
- GitHub E2E lifecycle passes.
- security/prompt injection tests pass.
- large-repo stress test does not exhaust service resources.

---

# 32. Phase 2 — hardening only

Phase 2 may include:

- bug fixes
- parser correctness improvements within supported formats
- false-positive reduction
- prompt/ranking/verification tuning
- evaluation dataset expansion
- provider API compatibility fixes
- additional recommended model profiles
- performance and caching improvements
- large-repository scaling
- database/index tuning
- runner reliability improvements
- security hardening
- observability improvements
- UX polish

Phase 2 must not be used as an excuse to defer a required Phase 1 production capability.

New product surfaces such as browser extensions, IDE extensions, runtime browser crawling, or non-GitHub SCM integrations are outside this two-phase plan.

---

# 33. Master implementation prompt for Claude Code or Codex

Copy the text below into the coding agent together with this specification.

```text
You are the principal engineer responsible for implementing Humanize, a production-grade GitHub App that reviews user-visible repository content in pull requests.

The attached Humanize Final Engineering Build Specification is the authoritative architecture and requirements document.

FIRST TASK — DO NOT CODE YET:
1. Read the entire specification.
2. Inspect the repository completely.
3. Map the current repository to the specification's monorepo architecture, requirements, invariants, and Phase 1 task IDs.
4. Identify what already exists, what is missing, and any conflicts.
5. Produce an implementation plan in Phase 1 stage order (P1-S0 through P1-S11).
6. For each task, list files/modules/migrations/tests that must be created or changed.
7. Call out security-sensitive work explicitly.
8. Do not omit a requirement because it is difficult.
9. If you believe the specification contains a technical contradiction, identify it precisely with evidence before proposing a change.

NON-NEGOTIABLE ARCHITECTURE:
- The product is a GitHub App, not primarily a GitHub Action.
- Contents permission is read-only in Phase 1.
- Customer repository code is NEVER executed.
- Repository checkouts are ephemeral.
- Every tracked file is enumerated and classified; only relevant user-visible content is parsed/reviewed.
- Source positions come from parsers/diffs, never model guesses.
- Humanize never claims certainty that text is AI-authored; use AI-like/generic content findings.
- Review uses deterministic extraction/context + structured reviewer + verification + ranking/dedupe.
- Do not create an agent swarm.
- PostgreSQL stores operational state; raw repositories are never persisted.
- Core retrieval must work without vectors; pgvector is optional.
- Provider abstraction must support OpenAI, Gemini, OpenRouter, and Ollama.
- Local Ollama runs through the self-hosted Humanize Runner. The cloud service cannot call customer localhost directly.
- Never silently fall back from local/private execution to a cloud model.
- Use GitHub native suggestion blocks for one-click fixes; no autonomous branch writing in Phase 1.
- Subjective AI-like findings are advisory by default and do not block merge.
- No payment/billing system.
- No runtime browser crawling, graph DB, Redis, Kafka, Kubernetes, VS Code extension, or browser extension in Phase 1.

IMPLEMENTATION BEHAVIOR:
- Use TypeScript strict mode and pnpm workspaces.
- Preserve package boundaries from the specification.
- Validate every external payload and model output with Zod.
- Use database migrations; never mutate schema ad hoc.
- Use tests before calling a stage complete.
- After each stage, run typecheck, lint, unit tests, relevant integration tests, and migration validation.
- Report exact acceptance evidence against the task IDs.
- Keep a running checklist of requirements and do not mark tasks complete without evidence.

Once the planning output is complete, stop and present it for review before implementing Stage P1-S0 unless I explicitly instruct you to continue.
```

---

# 34. Per-stage implementation prompt

Use this after the master plan has been reviewed.

```text
Implement Humanize Stage <STAGE_ID> only.

Before editing:
1. Re-read the stage tasks, dependencies, system invariants, and relevant architecture sections.
2. Inspect the existing implementation from prior stages.
3. State the concrete files/migrations/tests you will change.

While implementing:
- Do not change architecture outside this stage unless required to fix a proven contradiction.
- Preserve public interfaces already introduced unless a migration is documented.
- Add tests for success, failure, retry, authorization, and idempotency paths where relevant.
- Never leave TODO placeholders for a requirement that is part of this stage's exit criteria.

Before finishing:
1. Run typecheck.
2. Run lint.
3. Run unit tests.
4. Run stage-specific integration/evaluation tests.
5. Run database migration validation when relevant.
6. Review your own diff for security, stale-state bugs, tenant isolation, secret leakage, and unhandled failures.
7. Map evidence to every task ID in this stage.
8. List any known limitation. Do not claim the stage is complete if an exit criterion is not met.
```

---

# 35. Independent architecture/implementation audit prompt

Give this to a second Claude/Codex session after planning or after major implementation stages.

```text
Act as an adversarial principal engineer reviewing the Humanize implementation against the attached Final Engineering Build Specification.

Do not rewrite the project. Audit it.

Check, at minimum:
1. Does the implementation actually behave as a GitHub App with least-privilege permissions?
2. Can duplicate/reordered webhook deliveries produce duplicate reviews?
3. Can a stale head SHA publish findings after a new commit?
4. Is any customer repository code executed, directly or indirectly?
5. Are repository workspaces definitely cleaned after success, failure, timeout, and cancellation?
6. Does the extractor confuse internal string literals with user-visible content?
7. Are source ranges deterministic and parser-derived?
8. Can a model fabricate evidence, line numbers, paths, or repository context that reaches GitHub?
9. Are reviewer and verifier truly separate invocations and is verification bypassed incorrectly?
10. Are AI-like findings phrased as content observations rather than proof of authorship?
11. Is approved voice incorrectly inferred from arbitrary repository content?
12. Can a suggestion remove variables/placeholders or break JSX/JSON/YAML/Markdown syntax?
13. Does the system reparse every proposed one-click patch before publishing it?
14. Are OpenAI, Gemini, OpenRouter, and Ollama isolated behind one provider contract?
15. Does Gemini use current auth-key behavior rather than legacy assumptions?
16. Does OpenRouter verify selected model structured-output capability?
17. Can Ollama/private execution ever silently fall back to a cloud model?
18. Can the cloud service accidentally attempt to call customer localhost?
19. Does the runner receive more GitHub permission than necessary?
20. Are provider secrets ever returned to clients or written to logs?
21. Does Postgres store entire repository/source files unnecessarily?
22. Does the product still function with vector retrieval disabled?
23. Is tenant isolation enforced in every database/API path?
24. Can repository prompt injection alter control policy or access tools/secrets?
25. Are the eval thresholds measured and enforced rather than documented only?
26. Are Phase 1 task IDs actually complete with evidence?

Output:
- CRITICAL issues
- HIGH issues
- MEDIUM issues
- LOW issues
- Missing requirements by ID
- Security risks
- Reliability/race-condition risks
- Accuracy risks
- Overengineering or unnecessary dependencies
- Specific recommended fixes with file/module locations

Do not approve the implementation merely because tests pass. Verify the architecture and failure modes.
```

---

# 36. Research-validated assumptions and references

The architecture above was rechecked against current public documentation and recent research.

## GitHub

- GitHub App permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub App webhooks: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps
- Validating webhook signatures: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- Installation access tokens: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- Pull request review comments: https://docs.github.com/en/rest/pulls/comments
- Pull request reviews: https://docs.github.com/en/rest/pulls/reviews
- Checks API: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks
- Suggested changes: https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/incorporating-feedback-in-your-pull-request

## CodeRabbit architecture patterns used as inspiration, not copied implementation details

- Context engineering: https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews
- Non-linear review + verification: https://www.coderabbit.ai/blog/the-art-and-science-of-context-engineering
- Context engine/harness/evaluation: https://www.coderabbit.ai/blog/explainable-reviews-coderabbit-review-context-engine
- IDE review pipeline discussion: https://www.coderabbit.ai/blog/how-we-built-our-ai-code-review-tool-for-ides

The relevant pattern is the **harness**: repository context, deterministic signals, model routing, candidate generation, verification, filtering, and evaluation. Humanize should replicate the pattern for content rather than pretending CodeRabbit's code graph or exact internal data stack applies directly.

## Model providers

- OpenAI structured outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI API authentication: https://developers.openai.com/api/reference/overview
- Gemini structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- OpenRouter structured outputs: https://openrouter.ai/docs/guides/features/structured-outputs
- OpenRouter developer API: https://openrouter.ai/developers
- Ollama API introduction: https://docs.ollama.com/api/introduction
- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Ollama embeddings: https://docs.ollama.com/api/embed

## AI-text detection caution

- Nature overview of detector progress and remaining limitations: https://www.nature.com/articles/d41586-026-02569-3
- Paraphrasing attack resilience study: https://arxiv.org/abs/2605.14240
- Cross-domain/style confounding study: https://arxiv.org/abs/2608.26710

These sources reinforce the product decision to report observable AI-like/generic writing signals rather than presenting an authorship percentage as ground truth.

---

# 37. Final founder/engineering conclusion

The finalized product should be built around this principle:

> **Humanize is not an AI-detector wrapper. It is a repository-aware content review harness.**

Its defensibility and quality come from:

```text
accurate visible-content extraction
+ exact source mapping
+ repository context
+ explicit approved voice/rules
+ deterministic signals
+ provider-neutral structured review
+ independent verification
+ aggressive noise suppression
+ GitHub-native workflow
+ safe one-click suggestions
+ continuous evaluation
```

If an implementation agent is tempted to spend most of its effort on prompt wording, model choice, fine-tuning, or multi-agent choreography before extraction/context/evaluation are excellent, it is optimizing the wrong layer of the system.

The core success test is simple:

> **Would a software team leave Humanize installed because it repeatedly catches embarrassing, generic, inconsistent, or low-quality customer-facing content before it ships—without annoying them with false positives?**

Phase 1 is complete only when the answer can credibly be yes.
