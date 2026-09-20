# Implementation roadmap

Approved execution order is S00–S20. Task IDs are immutable. A task is complete only with evidence; later stages do not waive earlier missing live or human validation.

## Stages

### P1-S00 — Documentation and architecture agreement

- [P1-S00-T01: Preserve upstream specification](tasks/P1-S00-T01.md)

- [P1-S00-T02: Document architecture and concerns](tasks/P1-S00-T02.md)

- [P1-S00-T03: Establish agent policy and navigation](tasks/P1-S00-T03.md)

- [P1-S00-T04: Materialize requirement and task traceability](tasks/P1-S00-T04.md)

### P1-S01 — Monorepo and executable contracts

- [P1-S01-T01: Create strict pnpm workspace](tasks/P1-S01-T01.md)

- [P1-S01-T02: Define versioned domain contracts](tasks/P1-S01-T02.md)

- [P1-S01-T03: Create CI and trusted test harness](tasks/P1-S01-T03.md)

- [P1-S01-T04: Bootstrap local PostgreSQL](tasks/P1-S01-T04.md)

- [P1-S01-T05: Create redacted telemetry foundation](tasks/P1-S01-T05.md)

### P1-S02 — Restricted repository acquisition and diff geometry

- [P1-S02-T01: Implement restricted Git acquisition](tasks/P1-S02-T01.md)

- [P1-S02-T02: Implement ephemeral workspace lifecycle](tasks/P1-S02-T02.md)

- [P1-S02-T03: Enumerate and classify all tracked files](tasks/P1-S02-T03.md)

- [P1-S02-T04: Compute merge-base PR diff geometry](tasks/P1-S02-T04.md)

### P1-S03 — First extraction and source-range proof

- [P1-S03-T01: Define source mapping and identity](tasks/P1-S03-T01.md)

- [P1-S03-T02: Extract Babel visible content](tasks/P1-S03-T02.md)

- [P1-S03-T03: Extract Markdown and MDX](tasks/P1-S03-T03.md)

- [P1-S03-T04: Extract placeholder metadata](tasks/P1-S03-T04.md)

- [P1-S03-T05: Create extraction evaluation harness](tasks/P1-S03-T05.md)

### P1-S04 — All four provider contracts

- [P1-S04-T01: Implement neutral schema projection](tasks/P1-S04-T01.md)

- [P1-S04-T02: Normalize retries and errors](tasks/P1-S04-T02.md)

- [P1-S04-T03: Implement OpenAI Responses adapter](tasks/P1-S04-T03.md)

- [P1-S04-T04: Implement Gemini adapter](tasks/P1-S04-T04.md)

- [P1-S04-T05: Implement OpenRouter adapter](tasks/P1-S04-T05.md)

- [P1-S04-T06: Implement local Ollama adapter](tasks/P1-S04-T06.md)

- [P1-S04-T07: Implement connection probes and contract suite](tasks/P1-S04-T07.md)

### P1-S05 — Durable state secrets and scheduling

- [P1-S05-T01: Create tenant and configuration schemas](tasks/P1-S05-T01.md)

- [P1-S05-T02: Create review and publication metadata](tasks/P1-S05-T02.md)

- [P1-S05-T03: Implement encrypted SecretStore](tasks/P1-S05-T03.md)

- [P1-S05-T04: Implement transactional durable queue](tasks/P1-S05-T04.md)

- [P1-S05-T05: Implement persisted review transitions](tasks/P1-S05-T05.md)

- [P1-S05-T06: Exercise durable concurrency failures](tasks/P1-S05-T06.md)

### P1-S06 — GitHub ingestion and early race proof

- [P1-S06-T01: Implement App token broker](tasks/P1-S06-T01.md)

- [P1-S06-T02: Verify raw webhook signatures](tasks/P1-S06-T02.md)

- [P1-S06-T03: Deduplicate and recover deliveries](tasks/P1-S06-T03.md)

- [P1-S06-T04: Route installation and PR lifecycle](tasks/P1-S06-T04.md)

- [P1-S06-T05: Route default-branch pushes](tasks/P1-S06-T05.md)

- [P1-S06-T06: Prove GitHub check and review transport](tasks/P1-S06-T06.md)

### P1-S07 — Runner identity and lease protocol

- [P1-S07-T01: Create runner lease persistence](tasks/P1-S07-T01.md)

- [P1-S07-T02: Implement enrollment and heartbeat](tasks/P1-S07-T02.md)

- [P1-S07-T03: Implement outbound lease protocol](tasks/P1-S07-T03.md)

- [P1-S07-T04: Issue job-scoped GitHub credentials](tasks/P1-S07-T04.md)

- [P1-S07-T05: Validate runner result envelopes](tasks/P1-S07-T05.md)

### P1-S08 — First useful-review and runner vertical slice

- [P1-S08-T01: Resolve trusted configuration](tasks/P1-S08-T01.md)

- [P1-S08-T02: Build ephemeral lexical context](tasks/P1-S08-T02.md)

- [P1-S08-T03: Implement deterministic rules and routing](tasks/P1-S08-T03.md)

- [P1-S08-T04: Implement first reviewer and verifier pipeline](tasks/P1-S08-T04.md)

- [P1-S08-T05: Evaluate first useful-review corpus](tasks/P1-S08-T05.md)

- [P1-S08-T06: Connect local runner execution](tasks/P1-S08-T06.md)

### P1-S09 — HTML localization and deterministic resolution

- [P1-S09-T01: Extract HTML text and attributes](tasks/P1-S09-T01.md)

- [P1-S09-T02: Extract JSON and YAML localization](tasks/P1-S09-T02.md)

- [P1-S09-T03: Resolve safe constants and translations](tasks/P1-S09-T03.md)

- [P1-S09-T04: Extend placeholder and failure corpus](tasks/P1-S09-T04.md)

### P1-S10 — Vue Svelte CSS and extraction gate

- [P1-S10-T01: Extract Vue static templates](tasks/P1-S10-T01.md)

- [P1-S10-T02: Extract Svelte static templates](tasks/P1-S10-T02.md)

- [P1-S10-T03: Extract CSS generated content](tasks/P1-S10-T03.md)

- [P1-S10-T04: Enforce full extraction release gate](tasks/P1-S10-T04.md)

### P1-S11 — Parser-safe suggestions

- [P1-S11-T01: Encode source-specific replacements](tasks/P1-S11-T01.md)

- [P1-S11-T02: Preserve placeholder semantics](tasks/P1-S11-T02.md)

- [P1-S11-T03: Reparse and prove structural preservation](tasks/P1-S11-T03.md)

- [P1-S11-T04: Render diff-eligible GitHub suggestions](tasks/P1-S11-T04.md)

### P1-S12 — Indexed baselines and production retrieval

- [P1-S12-T01: Create atomic baseline generations](tasks/P1-S12-T01.md)

- [P1-S12-T02: Cache extraction by blob and configuration](tasks/P1-S12-T02.md)

- [P1-S12-T03: Update baseline incrementally](tasks/P1-S12-T03.md)

- [P1-S12-T04: Implement PostgreSQL lexical retrieval](tasks/P1-S12-T04.md)

- [P1-S12-T05: Separate approved voice and baseline stats](tasks/P1-S12-T05.md)

- [P1-S12-T06: Complete snapshot context construction](tasks/P1-S12-T06.md)

### P1-S13 — Complete review verification and noise policy

- [P1-S13-T01: Complete category schemas and evidence validation](tasks/P1-S13-T01.md)

- [P1-S13-T02: Complete independent verifier](tasks/P1-S13-T02.md)

- [P1-S13-T03: Implement bounded context expansion](tasks/P1-S13-T03.md)

- [P1-S13-T04: Rank and deduplicate findings](tasks/P1-S13-T04.md)

- [P1-S13-T05: Apply PR budget and generate summaries](tasks/P1-S13-T05.md)

### P1-S14 — Production GitHub publication

- [P1-S14-T01: Fence publishing and recheck freshness](tasks/P1-S14-T01.md)

- [P1-S14-T02: Publish and reconcile grouped reviews](tasks/P1-S14-T02.md)

- [P1-S14-T03: Apply check and incomplete-review policy](tasks/P1-S14-T03.md)

- [P1-S14-T04: Run full GitHub lifecycle stress suite](tasks/P1-S14-T04.md)

### P1-S15 — Production runner execution and distribution

- [P1-S15-T01: Complete shared runner execution](tasks/P1-S15-T01.md)

- [P1-S15-T02: Independently validate runner results](tasks/P1-S15-T02.md)

- [P1-S15-T03: Package and document runner](tasks/P1-S15-T03.md)

- [P1-S15-T04: Exercise runner failure recovery](tasks/P1-S15-T04.md)

### P1-S16 — Authentication and administration dashboard

- [P1-S16-T01: Implement GitHub sign-in and authorization](tasks/P1-S16-T01.md)

- [P1-S16-T02: Manage repositories and organization policy](tasks/P1-S16-T02.md)

- [P1-S16-T03: Manage encrypted provider credentials](tasks/P1-S16-T03.md)

- [P1-S16-T04: Configure model roles and fallback](tasks/P1-S16-T04.md)

- [P1-S16-T05: Manage runner enrollment and status](tasks/P1-S16-T05.md)

### P1-S17 — Learnings feedback history and retention

- [P1-S17-T01: Manage scoped explicit learnings](tasks/P1-S17-T01.md)

- [P1-S17-T02: Record explicit and inferred feedback](tasks/P1-S17-T02.md)

- [P1-S17-T03: Display redacted review history](tasks/P1-S17-T03.md)

- [P1-S17-T04: Implement retention transitions and purge](tasks/P1-S17-T04.md)

### P1-S18 — Optional embeddings and vector retrieval

- [P1-S18-T01: Implement optional embedding adapters](tasks/P1-S18-T01.md)

- [P1-S18-T02: Version embedding spaces and optional pgvector](tasks/P1-S18-T02.md)

- [P1-S18-T03: Evaluate vectors and vector-off behavior](tasks/P1-S18-T03.md)

### P1-S19 — Security observability and final evaluation

- [P1-S19-T01: Complete telemetry and alerts](tasks/P1-S19-T01.md)

- [P1-S19-T02: Run adversarial security review](tasks/P1-S19-T02.md)

- [P1-S19-T03: Run resource and outage stress tests](tasks/P1-S19-T03.md)

- [P1-S19-T04: Run frozen release evaluation gates](tasks/P1-S19-T04.md)

### P1-S20 — Deployment recovery and release acceptance

- [P1-S20-T01: Prove backup restore and migration recovery](tasks/P1-S20-T01.md)

- [P1-S20-T02: Exercise operational runbooks](tasks/P1-S20-T02.md)

- [P1-S20-T03: Package cloud reference deployment](tasks/P1-S20-T03.md)

- [P1-S20-T04: Audit Phase 1 Definition of Done](tasks/P1-S20-T04.md)
