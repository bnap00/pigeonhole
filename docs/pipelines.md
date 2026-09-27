# Writing a pipeline

A pipeline is one YAML file. The builder UI, the CLI and the API all read and
write the same spec, so UI users and git users never diverge.

```yaml
pigeonhole: 1
id: support-triage
description: Route support tickets to returns, shipping or billing.

input:
  type: object
  properties:
    body: { type: string, maxLength: 20000 }
  required: [body]

model:
  runtime: jev-latest          # or pin: typesafe/jev-1.13; or laya (docs/laya.md)
  compiler: anthropic/claude-sonnet-5

nodes:
  department:
    type: choice
    instructions: Which team should handle this ticket?
    criteria:
      returns:
        what: "Exchanges, wrong or damaged items, anything sent back."
        not_for: "Late deliveries with no return request — those are shipping."
        examples: ["Wrong size, I need a 10 instead of a 9."]
      shipping: { what: "Where an order is, delays, lost packages." }
      billing:  { what: "Charges, invoices, double payments." }
      other:    { what: "Anything that fits none of the above." }
    min_confidence: 0.35
    on_low_confidence: human_review

  angry:
    type: noul                 # the probability a statement is true
    instructions: The customer is angry or threatening to churn.

  priority:
    type: rule                 # no model call
    expr: 'angry.p > 0.7 ? "high" : "normal"'

output:
  team: department.choice
  priority: priority.value
  needs_review: department.low_confidence

tests:
  - input: { body: "Shoes came in the wrong size, can I swap for a 10?" }
    expect: { team: returns }
```

Five templates ship in [`templates/`](../templates) as working examples.

## Node types

They map straight onto the model's primitives, so Pigeonhole never invents
classification semantics of its own.

| Type | Returns | Model call |
| --- | --- | --- |
| `choice` | One of N options, a probability for each, and a confidence | Yes |
| `score` | The most likely level on an integer scale (`min`..`max`, 2 to 50 levels, each optionally labelled), a probability per level, and a confidence | Yes |
| `noul` | The probability a yes/no statement is true | Yes |
| `rule` | Deterministic logic over other answers | No |

For `choice`, each option has `what`, and optionally `not_for` and `examples`.
`not_for` is where disambiguation lives: say in A's `not_for` what belongs in
B, and the reverse.

## Execution

Independent model nodes are batched into **one model call**. Only a node that
needs another node's *answer as its input* costs a second round trip. The
builder's graph shows the real layering.

- **`when`** decides whether an answer is *used*, not whether it is asked.
  Nodes are asked speculatively because one more question costs tokens but
  almost no latency. `lazy: true` opts out — right for a 500-option taxonomy.
- **`min_confidence`** with **`on_low_confidence`** handles uncertain answers:
  `human_review`, `error`, or `default:<option>`. There is no fallback to a
  second model: classifications come only from decision models such as Jev,
  and `fallback_model` — which re-asked a chat model — is rejected. Thresholds
  are meaningful because decision models are calibrated: of all answers given
  at 0.9, about 90% are right. A chat model's self-reported probabilities carry
  no such guarantee.
- **`also_above: 0.25`** returns every other option above that probability,
  for multi-team routing.

## Expressions

`when`, `rule` and `output` use a small sandboxed language: no `eval`, no host
access, no prototype reach. A bare node name means its answer, so
`department == "returns"` and `department.choice == "returns"` are equivalent.

## Tests

Every test input must satisfy the pipeline's own `input` schema — including
every `required` field — or it cannot run. See [evals](evals.md).

## Runtime settings

Optional, every key with a safe default:

```yaml
compose:
  cache:
    mode: memory             # off | memory   (default: off)
    ttl: 300
  logging:
    telemetry: postgres      # postgres | none
    retain: low_confidence   # all | sampled | low_confidence | none
    retention_days: 90
    input: full              # full | hash_only | off
    redact_pii: false
```

Since the storage is yours, `retain: all` is reasonable here rather than
expensive — which is what lets the review queue reach back months and turn real
traffic into test cases.
