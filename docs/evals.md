# Evals and drift

`jev-latest` moves to new model releases on its own, so a pipeline can change
behaviour with no change on your side. Evals are what notice.

## Test cases

Tests come from three places:

- **The compiler** writes 10–30 labelled cases when it compiles a description,
  covering every option plus edge cases between options.
- **You**, in the spec's `tests:` block or the builder's test panel.
- **Feedback** on real runs, promoted from the review queue.

Only keys with a stable answer are labelled. Probabilities and confidence
values are deliberately never asserted — no one can say in advance that an
input deserves 0.83 rather than 0.86.

## Running

```bash
pigeonhole test [pipeline]      # non-zero exit on regression: your CI gate
```

Or **Run eval** in the builder. Each report has accuracy per output key and per
node, a confusion matrix, and a calibration curve: of answers given at
confidence ≥ t, what share were correct. A well-calibrated model tracks the
diagonal.

## Nightly and drift

Every published pipeline is evaluated nightly (02:00 UTC). When accuracy drops
by more than 3 points (`driftThreshold` in `src/config.ts`), it raises a drift
alert: recorded in the database, and posted to every webhook registered for
`drift` (`POST /v1/webhooks`). The alert says whether the resolved model
version moved, which is the usual cause.

## Comparing models

```bash
pigeonhole diff support-triage --models typesafe/jev-1.13,jev-latest
```

Runs both on the same test set and reports the accuracy delta and the
regressions.

## Cases that cannot run

A case can fail to reach the model: the provider is down or unreachable, or
the input fails the pipeline's own input schema. That is not a wrong answer,
and it says nothing about the pipeline, so it is never counted as one.

- **Accuracy is measured on the cases that ran.** The rest are reported
  separately — *"3 of 25 cases could not run"* — with their reasons.
- **When no case runs, there is no accuracy.** The panel shows a dash, and the
  eval is stored as *failed*. It does not become the version's score, and a nightly run is not compared for
  drift. Otherwise a provider outage would read as a 100-point accuracy drop
  and raise a drift alert on every pipeline.
- **The panel names the cause.** A provider error means OpenRouter could not answer (`make logs`); a
  schema mismatch means the tests were written against an older schema —
  recompile and accept the result to regenerate them.

The compiler requires every input field in the tests it generates and drops
any that fail the schema. Its dry run follows the same rule, and does not
spend a repair pass rewriting definitions when no case produced an answer to
learn from.
