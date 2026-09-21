# Detecting AI-like writing: method and justification

This document states how Humanize decides that a passage reads as machine-made, why the method
is built the way it is, and how the claim is proved. It exists so the behaviour can be argued
about on evidence rather than on intuition.

## What is being claimed, and what is not

Humanize does **not** detect authorship. It cannot, and neither can anything else reliably:
detector accuracy varies sharply with model, domain and paraphrasing, and a false accusation of
machine authorship is worse for a developer than silence. INV-006 and ADR-009 forbid the claim
outright.

What is claimed is narrower and checkable: **this passage carries several observable markers
that machine-generated prose carries far more often than careful human prose, and here is which
ones.** Every published finding names the markers. A reader can disagree with the judgement by
looking at the same evidence.

## Why no single marker is used

The literature and the editorial reporting agree on this, from opposite directions.

- The em dash is widely described as the most visible marker of generated prose, and the same
  reporting is explicit that it cannot carry a judgement alone, because models learned the habit
  from well-edited human writing. Flagging em dashes would flag good editors.
- The `not X — it's Y` construction is a genuine LLM habit and also a rhetorical figure found in
  Shakespeare and the Bible.
- Measures that do discriminate — lexical diversity, dispersion, sentence-length uniformity —
  are reported as strongly dependent on the specific model and domain.

Quantitatively, combined feature sets reach F1 ≈ 0.94 where perplexity alone reaches ≈ 0.81. The
signal is in the *agreement between independent markers*, not in any one of them.

This is why a single construction match is evidence here and never a finding.

## The families

Each family is an independent way of observing the same passage. Two signals from one family are
one observation, not two, so a single habit cannot corroborate itself.

| Family | What it observes | Standalone? |
|---|---|---|
| Formulaic construction | Negation reframing, strawman contrast, no-X-just-Y, scene-setting opener, em-dash tagline appositive | No |
| Punctuation profile | Em-dash rate relative to passage length | No |
| Low-information vocabulary | Known promotional phrases, matched across inflection | Only as a cluster of three or more (ADR-037) |
| Padded phrasing | Wordiness templates carrying no content | Yes |
| Uniform sentence rhythm | Low variance in sentence length | No |
| Modifier density | Superlatives and `-ly` adverbs above a rate | No |
| Repeated openings | Three or more sentences starting with the same word | Yes (ADR-037) |

A **corroborated finding** is published when two or more distinct families fire on one passage
([ADR-039](../adr/ADR-039.md)). The finding states which families agreed and what each observed.

Statistical families deliberately never publish alone. They are the likeliest source of false
positives on short product copy, where a two-sentence paragraph can look "uniform" by accident.

## Why the rules propose almost no rewrites

A suggestion changes *how* something is written, never *what* it says. Two constraints follow.

**A rule may only propose a deletion when what it removes is a negation of the claim beside it.**
Removing `— not randomly generated —` from "intentionally designed — not randomly generated — to
support focus" leaves every positive statement intact. By contrast, deleting "— Designed for the
Mind" from a heading removes a claim about what the product is for. That is information loss
wearing a rewrite's clothes, and the rule that used to do it has been withdrawn.

**Every replacement, including one a model proposes, passes an information-loss check** before a
patch is built: numbers, percentages, acronyms, brand tokens with internal capitals and URLs
present in the original must survive. Ordinary capitalisation is deliberately not treated as a
proper noun, because headings are often title case and every word would look like a fact.

This is a backstop, not a semantic guarantee. It cannot tell that a dropped clause lost an
argument. That is why rules decline to rewrite prose at all and leave it to a model or a person,
and why anything that fails stays a comment, which is always publishable.

## How the claim is proved

The deterministic layer answers to no verifier: whatever it fires on reaches a pull request. Its
precision is therefore a release-blocking property, and it is measured with no model involved, in
the default test lane, by `evals/review/deterministic.test.ts`.

The corpus carries hard negatives chosen to break the rules rather than to flatter them: a
legitimate em-dash aside carrying real information, a specific technical contrast, an em dash as
a plain heading separator, a correcting "not a failure", and three pieces of honest promotional
copy that share vocabulary with the flagged cases.

| Measurement | Before constructions | With constructions, uncorroborated | With corroboration required |
|---|---|---|---|
| Positives flagged | 7 / 15 | 12 / 15 | **10 / 15** |
| False positives | 0 / 20 | 0 / 20 | **0 / 20** |
| Precision | 100% | 100% | **100%** |
| Recall | 47% | 80% | **67%** |

Requiring corroboration cost five points of recall and bought the guarantee that no finding rests
on a single marker. That is the correct trade for this product: the specification optimises for
the precision of inline comments, because a reviewer that comments on sound writing gets
uninstalled, while one that misses a weak sentence is merely less useful.

Two structural cases are observed but deliberately held back for want of corroboration. The test
asserts that they are held back, so a later change that publishes them is a visible decision
rather than a drift.

## What this method does not yet do

- **No perplexity or lexical-diversity measurement.** Dispersion and MATTR are among the
  strongest reported discriminators, and both need passages longer than the product typically
  reviews. A heading is four words; these measures are meaningless there. They belong at file or
  pull-request scope, which is not implemented.
- **No calibration against a held-out set.** The corpus is 35 cases and development-only.
  `docs/evaluation/README.md` requires at least 300 review cases with a separate held-out set and
  two independent human adjudicators. Nothing here substitutes for that.
- **No measurement of the model half.** Every published model finding survives a verifier that
  currently suppresses 10 or 11 of roughly 16 candidates per run. Whether that filter is right is
  unmeasured.
- **Thresholds are reasoned, not fitted.** The em-dash density rule and the two-family
  requirement were chosen from the reasoning above and then measured, not optimised against the
  corpus. Fitting them to 35 cases would produce numbers that describe the corpus rather than the
  product.

## Sources

- [A Systematic Analysis of Linguistic Features in AI-Generated Text Detection Across Domains and Models](https://arxiv.org/html/2606.04177)
- [Can You Detect the Difference?](https://arxiv.org/html/2507.10475)
- [Feature-Based Detection of AI-Generated Text: Stylometric and Perplexity Markers](https://www.researchgate.net/publication/398588043_Feature-Based_Detection_of_AI-Generated_Text_An_Analysis_of_Stylometric_and_Perplexity_Markers_in_Contemporary_Large_Language_Models)
- [Detecting the Machine: A Benchmark of AI-Generated Text Detectors](https://arxiv.org/pdf/2603.17522)
- ['ChatGPT Hyphen': Are Em Dashes a Giveaway of AI Writing?](https://www.rollingstone.com/culture/culture-features/chatgpt-hypen-em-dash-ai-writing-1235314945/)
- [How to spot when writing is AI: 6 elements of a robot's style](https://huntingthemuse.net/library/how-to-tell-if-writing-is-ai)
- [How To Avoid ChatGPT-Isms In Your Writing](https://www.forbes.com/sites/aytekintank/2026/03/31/how-to-avoid-chatgpt-isms-in-your-writing-and-your-teams-too/)
