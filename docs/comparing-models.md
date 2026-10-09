# Comparing models

Any decision model can run a pipeline. To see which one suits yours, run its
test cases on each:

```bash
pigeonhole bench --models jev-latest,laya,cloudflare/clef,cloudflare/clef-flash,openai/gpt-6-luna-decisions
pigeonhole bench support-triage moderation --models jev-latest,laya
```

`bench` sends the cases one at a time and prints, per pipeline and model, how
many passed, median and p95 latency, and cost. A bench stores no eval, so it
changes no version's score and no drift baseline. `--concurrency 8` runs the
cases in parallel, which is faster but measures latency under load. `--json`
prints every row. To compare two models and list the regressions on one
pipeline, use `pigeonhole diff <pipeline> --models a,b`.

## The models

| Model | Served by | |
| --- | --- | --- |
| `jev-latest`, or pinned: `typesafe/jev-1.13` | OpenRouter | The default |
| `cloudflare/clef`, `cloudflare/clef-flash` | OpenRouter | Cloudflare's open decision models, 27B and 9B |
| `openai/gpt-6-luna-decisions` | OpenRouter | GPT-6 Luna through OpenAI's Decisions API |
| `laya`, `laya-english`, `laya-multilingual` | Your machine | See [Laya](laya.md) |

The OpenRouter models all use `OPENROUTER_API_KEY`; nothing else to set up.

GPT-6 Luna can refuse a question. OpenRouter then fails the whole call, so
Pigeonhole drops the refused question, asks the rest again, and reports that
node as unanswered. That costs a second round trip.

## Results

Measured on 2026-10-09 against the local stack: Laya on an RTX 3050, the
hosted models through OpenRouter from India. Every test case of the five
templates plus a 24-case Reddit self-promotion pipeline, 74 in all, one at a
time after a warm-up pass. Latency is the median across pipelines of each
pipeline's median (and p95). Cost is what OpenRouter billed.

| | Jev | Laya (GPU) | Clef | Clef-flash | GPT-6 Luna |
| --- | --- | --- | --- | --- | --- |
| Correct | 68 (92%) | 39 (53%) | 65 (88%) | 64 (86%) | 67 (91%) |
| Median latency | 470 ms | 100 ms | 700 ms | 630 ms | 380 ms |
| p95 latency | 560 ms | 111 ms | 940 ms | 730 ms | 560 ms |
| Cost for 74 | $0.0027 | none | $0.0026 | $0.0014 | $0.0065 |
| Per million requests | about $37 | none | about $35 | about $19 | about $88 |

| Pipeline | Jev | Laya | Clef | Clef-flash | GPT-6 Luna |
| --- | --- | --- | --- | --- | --- |
| moderation | 8/10 | 9/10 | 7/10 | 7/10 | 10/10 |
| email-routing | 9/10 | 5/10 | 8/10 | 8/10 | 8/10 |
| support-triage | 10/10 | 7/10 | 10/10 | 10/10 | 10/10 |
| issue-labeling | 10/10 | 4/10 | 10/10 | 10/10 | 9/10 |
| lead-qualification | 9/10 | 4/10 | 9/10 | 8/10 | 8/10 |
| Reddit self-promotion | 22/24 | 10/24 | 21/24 | 21/24 | 22/24 |
| support-triage in Hindi | 10/10 | 6/10 | 10/10 | 10/10 | 10/10 |

- GPT-6 Luna refused `is_good_first_issue` on 6 of the 10 issue-labeling
  cases. Before refusals were handled, those 6 calls failed outright and the
  pipeline scored 3/10; the table shows the run after.
- Laya is the stock checkpoints, untrained on these tasks. Its latency is from
  the GPU; its support-triage, issue-labeling and Hindi answers were re-run on
  the CPU, which gives the same answers, while the GPU was busy.
- Support-triage, issue-labeling and the Hindi set were re-run after a fix to
  their templates: unquoted commas in `{ what: ... }` had cut some option
  descriptions short. `pigeonhole lint` now flags that as `split_criteria`.
- The specs favour Jev: the compiler dry-runs each spec's tests against Jev
  and repairs what Jev gets wrong.
- Cloudflare and OpenAI publish much lower per-token prices on their own
  APIs. These figures are OpenRouter's, the only route tested here.
- Run to run, a model moves by a case or two. Jev scored 69 and Laya 40 on the
  same suites two weeks earlier (41 after the template fix).
