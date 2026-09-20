# Evaluation fixtures

A small product repository in two versions. `before/` is the base commit and `after/` is the
head commit, so a review of the difference behaves like a real pull request.

The content is written to span the range a reviewer must handle: wording that should be left
alone, wording that should be flagged, and a phrase a customer has prohibited. Formats cover
JSX, Markdown, MDX, HTML and locale JSON, which also makes visible which formats the
extraction engine does not yet support — a format that yields no ContentNodes is not reviewed
at all, and that silence is a finding in its own right.

`evals/review/corpus.live.test.ts` builds a real Git repository from these directories and
runs the executor against a local model.
