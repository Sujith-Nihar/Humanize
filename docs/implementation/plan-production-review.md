# Plan: from working pipeline to usable product

The pipeline runs end to end and publishes to GitHub. It is not yet a product anyone would keep
installed: a review takes 10 to 13 minutes, the model half contributes almost nothing, and the
suggestions it does produce have twice proposed edits that lost the author's meaning.

This plan says what to change, in what order, and how each change will be judged. It is written
to be argued with — every stage names the measurement that would show it failed.

## What "usable" means here

1. A review of a typical pull request completes in **under two minutes**.
2. A published finding is **right almost always**; the corpus measures it, and precision on
   do-not-comment cases stays at 100%.
3. A suggestion **never loses what the author said**, and is applied rather than dismissed.
4. A reviewer that finds nothing **says why**, so silence is never ambiguous.

## Where it stands honestly

| | State |
|---|---|
| Ingestion, lease, execution, publication | Working live against a private repository |
| Deterministic detection | 10/15 corpus positives, 0/20 false positives |
| Model detection | ~16 candidates per run, 10–11 killed by the verifier, near-zero net contribution |
| Suggestions | Working, after two live failures forced an information-loss floor |
| Latency | **10–13 minutes**, against a target of two |
| Model calls | **One per node, sequential** — the architecture specifies 20 per batch |

## Benchmark: how CodeRabbit does it

Taken from their published architecture and independent write-ups, and worth stating because it
settles several arguments.

- **Deterministic first, at scale.** They run 20–25+ linters and SAST tools (Biome, Semgrep)
  before any model reasoning. Our equivalent is the rules package. The instinct — ground the
  review in things that cannot hallucinate — is the same, and validates keeping detection
  deterministic where it can be.
- **A separate judge model scores each finding and drops what it cannot ground.** That is exactly
  our verifier. Their reported purpose is holding down false positives, which is also ours.
- **Cheap models compress first.** Small models reduce a large file to the few parts that matter
  before an expensive model sees it. We have no equivalent, and it is the main reason their
  latency is tolerable at far larger scope.
- **Context breadth.** They assemble 10–15 signals: diff, code graph, linked tickets, CI failure
  logs, lint output, accumulated team preferences. We assemble changed nodes plus lexical
  neighbours. This is the widest gap, and mostly does not apply: prose review needs surrounding
  copy and approved voice, not a call graph.
- **Learnings, bi-directional.** They separate agentic learnings from user learnings. We have
  `explicit_learnings`, written deliberately, and the review pipeline does not read them yet.
- **Pipeline anchored, agentic at the edges.** Their own framing places them between the two.
  That is the position this plan takes as well.

**Not adopted:** sandboxed build and execution of the repository. INV-001 forbids executing
customer code, and prose review does not need it.

## Decisions taken

### One revise, not three

Reflection is kept, bounded to **one revise attempt**, and the critic is deterministic.

The evidence is one-sided: intrinsic self-correction — a model critiquing its own output with no
external signal — does not improve results and frequently degrades them through overcorrection.
It works when the critique comes from outside: a compiler, a test suite, a verifier.

Humanize can produce that external signal for prose, which is unusual. `TEXT_TRUNCATED`,
`FACT_DROPPED`, `PLACEHOLDER_REMOVED`, `REPARSE_FAILED` and `STRUCTURE_CHANGED` are
compiler-grade facts about a rewrite. A loop whose critic is those gates is in the category the
research supports.

Three iterations were rejected for now: returns diminish quickly, each iteration costs a model
call, and nothing yet shows the second adds anything. The loop is written so the bound is a
constant, and stage 5 measures whether raising it helps. If it does not, it stays at one and the
ADR records that.

### Semantic judgement stays a single pass

The gates cannot decide whether a rewrite still *means* what the original meant. That one
question goes to the verifier, once, in the shape CodeRabbit uses a judge — not a debate, not a
swarm. ADR-011 rejects swarms and the reasoning holds.

## The stages

### Stage 1 — Batch the model calls

**Change.** `reviewNodes` calls the model once per node. Send up to `LIMITS.nodeBatch` (20) nodes
per reviewer call, as the architecture already specifies, with the response keyed by node id.
Verify only the nodes that produced candidates.

**Why first.** 12 nodes currently cost 24 sequential round-trips. Every later experiment is
gated on this: a 3-minute measurement loop is usable, a 25-minute one is not.

**Acceptance.** A 12-node review completes in under two minutes on `llama3.2`. Per-node
isolation of failures is preserved — one malformed entry must not discard the batch, which is
the property `reviewNodes` already guarantees per node and must keep.

**Risk.** Batching invites the model to mix up node ids. The existing gate already discards a
candidate naming the wrong node (`foreign_node`), so the failure mode is suppression rather than
misplacement. Worth measuring: `SUPPRESSED_FOREIGN_NODE` counts before and after.

### Stage 2 — Measure the models

**Change.** Run `evals/review/gate.live.test.ts` over the installed models — `llama3.2`,
`llama3.1:8b`, `qwen3:8b`, `mistral` — and record precision, recall and wall-clock per model.

**Why.** Every remaining question ("is the verifier too aggressive", "can a model rewrite well",
"is 0.90 the right threshold") is unanswerable without this. It is cheap and local.

**Acceptance.** A table in the evaluation docs naming model, precision, recall, suppression rate
and duration. No tuning happens before it exists.

### Stage 3 — Evidence fusion

**Change.** Deterministic and model layers currently publish independently. Make each inform the
other's threshold:

| Node has | Today | After |
|---|---|---|
| 2+ deterministic families | publishes | publishes |
| 1 family + model agrees | model finding at 0.90 | corroborated: lower threshold |
| 0 families + model finding | publishes at 0.90 | unsupported: higher threshold |
| 1 family, model silent | nothing | evidence only, as now |

**Why.** This is the hybrid the product claims to be. Today it is two pipelines side by side.

**Acceptance.** Corpus precision stays at 100%; recall rises above the current 10/15. If recall
does not move, the fusion is not earning its complexity and should be reverted.

### Stage 4 — The rewrite loop

**Change.** For each publishable finding: propose a rewrite, run the deterministic gates, and on
failure revise **once** with the exact reasons. Then one verifier pass for meaning. Publish only
a survivor; otherwise comment-only, recording why it never converged.

**Acceptance.** On the corpus, the share of findings carrying an applicable suggestion rises,
with zero suggestions refused for `TEXT_TRUNCATED` or `FACT_DROPPED` reaching a pull request —
they are caught before publication, as they are today.

**Needs an ADR.** It adds a bounded loop to the review path and changes what a suggestion is.

### Stage 5 — Does iteration two help?

**Change.** Raise the bound to two, measure, keep the better setting.

**Acceptance.** A recorded comparison. If the second iteration does not improve the survivor rate
materially, the bound stays at one and the ADR says so.

### Stage 6 — Only review what changed

**Change.** Cache review outcomes by node identity (`stableKey` plus content hash). On a new
push, review only nodes whose text actually changed.

**Why.** A developer pushing five commits should not pay for five full reviews, and this is what
makes re-review affordable in a real workflow.

**Acceptance.** A second review of an unchanged node performs zero model calls.

### Stage 7 — Read the learnings

**Change.** The configuration precedence chain includes explicit learnings; the pipeline does not
read them. Feed `LearningStore.forPath` into the reviewer's evidence.

**Why.** It is the only memory the product has, an administrator has already written it down, and
it is currently inert.

## Sequencing and why

1 → 2 → 3 → 4 → 5 → 6 → 7.

Stage 1 makes everything else measurable. Stage 2 makes stages 3 to 5 arguable instead of
guessed. Stages 6 and 7 are product-shaping rather than quality-shaping and can move earlier if a
real team starts using it.

## What this plan does not fix

- **Corpus size.** 35 development cases. `docs/evaluation/README.md` requires at least 300 with a
  held-out set and two independent human adjudicators before any release claim. Nothing here
  substitutes for that, and every number in this plan is development-set only.
- **Cloud providers.** OpenAI, Gemini and OpenRouter adapters have never been contacted live
  (P1-S04-T07). If local models cannot do the rewriting well, that is the next question, and it
  is the point at which the product starts costing money to run.
- **The 0.90 confidence threshold.** A documented starting point, never calibrated. Stage 2 is
  the prerequisite for touching it.
- **Human evaluation.** No independent reviewer has judged whether these findings are useful.
  That is the release gate the specification names, and it is not something this plan can close.
