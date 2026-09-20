# Evaluation and release gates

At least 400 extraction fixtures across every required syntax, positive and negative constructs. Report per-parser precision >=98%, recall >=90%, source-range accuracy >=99%; all published ranges still require deterministic validity. Safe suggestion fixture suite must pass 100%, with mutation/property cases.

At least 300 review cases spanning eight categories, content kinds, legitimate marketing, intentional deviation and false inconsistencies. Separate development and held-out sets. Two independent human reviewers adjudicate disagreements. At least 50 assessed major inline findings and >=80% usefulness/correctness; zero-output runs cannot pass vacuously. English is launch gate; other language/model combinations explicitly opt in as unevaluated.

Every report pins corpus/prompt/rule/ranking/parser/adapter/model-profile versions and records suppression/noise/coverage/latency/cost. Customer feedback/source is never automatically copied to datasets. Synthetic fixtures and automated checks do not substitute for independent human quality evaluation.
