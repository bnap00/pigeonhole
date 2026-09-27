# Laya

[Laya](https://www.layaaimodel.com) is an open-source (Apache 2.0) decision
model you run yourself. Like Jev it answers `choice`, `score` and `noul`
questions in one call with calibrated probabilities. Pigeonhole talks to it
through `laya-serve`, its HTTP server, which speaks Jev's wire format. Laya
runs on your machine, so classifications cost nothing and never leave it. It
needs a few GB of memory, though, and on a CPU it is slower than Jev.

Compiling still goes through OpenRouter: Laya classifies, but a chat model
writes the specs.

## Turn it on

Laya is an optional service in the same compose stack. Add the profile to
`.env`:

```bash
COMPOSE_PROFILES=laya
```

then run `make up`. The first start builds the image and downloads the
English and multilingual checkpoints (about 3 GB) into the `laya-models`
volume. `make up` waits until both are loaded, which can take several minutes
the first time. Later starts take seconds.

**On an NVIDIA GPU.** Install the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
and add the GPU override next to the profile:

```bash
COMPOSE_PROFILES=laya
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

The image is rebuilt with CUDA 12.6 wheels, which need driver 560 or newer.
With a 575+ driver you can set `LAYA_TORCH_INDEX=cu130` instead. Two
checkpoints take about 4 GB of GPU memory once they have served requests.

The support-triage template (four questions in one call), measured on a
6-core desktop:

| | English checkpoint | Multilingual checkpoint | Memory |
| --- | --- | --- | --- |
| GPU (RTX 3050) | 100–170 ms | 50 ms | about 4 GB of GPU memory |
| CPU (4 threads) | about 2 s | about 0.75 s | about 3.2 GB of RAM |

**Running it on the host instead.** Docker cannot use Apple silicon's GPU,
so on a Mac `laya-serve` is faster outside Docker:

```bash
python3 -m venv .laya && .laya/bin/pip install "laya[serve]"
LAYA_MODELS=english,multilingual .laya/bin/laya-serve     # listens on :8000
```

Set `LAYA_URL=http://host.docker.internal:8000` in `.env` and leave
`COMPOSE_PROFILES` unset. On Linux, also add
`extra_hosts: ["host.docker.internal:host-gateway"]` to the `app` service.

## Use it

Name a Laya model as a pipeline's runtime:

```yaml
model:
  runtime: laya
```

| Model | |
| --- | --- |
| `laya` | Laya picks the checkpoint per request: English, or multilingual for anything else |
| `laya-english` | ModernBERT-large, 421M parameters, English |
| `laya-multilingual` | mmBERT-base, 322M parameters, 100+ languages |
| `laya-typed-decisions` | Fine-tuned for Laya's typed-decisions workflows. Built on first use unless it is in `LAYA_MODELS` |

A response's `model` is the checkpoint that answered (`laya-english`, say),
so evals record it and drift alerts notice when it changes.

To make Laya the default for new compiles, set `PH_RUNTIME_MODEL=laya` in
`.env`. `make check` then probes Laya instead of OpenRouter.

To compare it with Jev on a pipeline's own test cases:

```bash
pigeonhole diff support-triage --models laya,jev-latest
```

## Limits

- **Short inputs.** The English checkpoint reads 512 tokens, about 320 of them
  input once the options take their share; the multilingual one reads 1,024.
  Laya cuts longer input off without an error, so use Jev for long documents.
- **Few options.** Options share a fixed token budget. Accuracy falls off past
  roughly 20 options in one `choice` node. `laya-serve` refuses more than 100
  options in a node and more than 32 levels on a scale.
- **Zero-shot.** The shipped checkpoints are not trained on your task. On the
  bundled templates' own test cases Laya passes 30 of 50: all of moderation,
  and 4 to 6 of 10 on the others. Run `pigeonhole test` before sending
  traffic to a pipeline on Laya, and check that its `min_confidence`
  thresholds still route what you expect.
- **One request at a time.** `laya-serve` runs one forward pass at a time and
  answers 503 when more than 16 requests are waiting.

## Settings

All optional, in `.env`:

| Variable | Default | |
| --- | --- | --- |
| `LAYA_MODELS` | `english,multilingual` | Checkpoints built at startup |
| `LAYA_THREADS` | `4` | CPU threads for inference; keep at or below the physical core count |
| `LAYA_TORCH_INDEX` | `cpu`, or `cu126` with the GPU override | Which PyTorch wheels the image installs |
| `LAYA_URL` | `http://laya:8000` | Where the app finds `laya-serve` |
| `LAYA_API_KEY` | | Bearer token, if your `laya-serve` requires one |

## Troubleshooting

**`make check` fails with `is the Laya server up`.** The app cannot reach
Laya. `make ps` shows whether `laya` is running; `make logs` shows it
downloading or loading checkpoints. It publishes no port, so test it from the
app container:
`docker compose exec app wget -qO- http://laya:8000/health`.

**The `laya` container restarts and its log ends mid-load.** It ran out of
memory. It is capped at 6 GB. Keep `LAYA_MODELS` to the checkpoints you use.

**On the GPU override, the log says `CUDA driver version is insufficient`.**
The wheels are newer than the driver. Update the driver, or set
`LAYA_TORCH_INDEX` to an older CUDA build, then run `make up`.
