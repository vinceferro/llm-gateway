# llm-gateway

**Your AI bill, with receipts.**

A local, OpenAI-compatible LLM gateway that sits under coding agents (opencode,
aider, claude-code): requests route by task class across swappable providers,
failover is sticky per key so provider prompt caches stay warm, every completed
call lands in a per-project JSONL ledger denominated in USD, and monthly budget
caps are enforced as hard `402`s before any upstream call is made. Zero runtime
dependencies; Node ≥ 22.6 (native TypeScript type-stripping — no build step).

```
opencode ──Bearer gateway-key──▶ llm-gateway (127.0.0.1:8090) ──provider key from env──▶ DeepSeek / Kimi / GLM / MiniMax / Ollama / mock
```

## Quickstart

```bash
git clone https://github.com/vinceferro/llm-gateway
cd llm-gateway
bash install.sh
gateway start          # shim lands in ~/.local/bin when it is on your PATH
```

`install.sh` does exactly this and nothing else:

1. preflight: bash, node ≥ 22.6, curl-or-wget, npm (clear fix hints on failure)
2. installs the app to `~/.llm-gateway/app` (copies the checkout you ran it
   from; otherwise shallow-clones `$LLM_GATEWAY_REPO_URL`)
3. generates `~/.llm-gateway/llm-gateway.json` via `src/bootstrap.ts` — admin
   key, one gateway key, local-model-server detection (`0600`). Never
   overwrites an existing config.
4. writes `~/.llm-gateway/env` for provider keys (placeholders only), and on
   Linux + systemd installs and enables a user unit
5. prints a finish panel with your gateway key and the exact next commands

If `~/.local/bin` is not on your PATH the shim is skipped and the start command
is `~/.llm-gateway/app/bin/gateway start` — the panel prints the path.

Then connect a tool and read the receipts:

```bash
gateway connect opencode     # or: aider, claude-code; --write merges the provider block
gateway report               # month-to-date receipt, straight from the ledger
```

Provider API keys live only in `~/.llm-gateway/env` as `export NAME=value`
lines — never in the config file, which names env vars, never key material.

## What it does

Feature list, scoped to what `src/server.ts` actually serves:

| route | auth | what |
|---|---|---|
| `POST /v1/chat/completions` | gateway key | streaming + non-streaming pass-through with a usage tap |
| `GET /v1/models` | gateway key | provider ids with pricing + task-class metadata |
| `GET /admin/usage?project=&month=YYYY-MM` | admin key | ledger totals, per-project/provider groups |
| `GET /healthz` | none | liveness |

Behind those routes:

- **Task-class routing.** A task class (`agentic-coding`, `bulk`, …) maps to an
  ordered provider chain; unknown or absent classes fall to `default`, never a
  client error. Optional `off_peak_chain` variants serve inside provider
  off-peak windows (UTC).
- **Sticky cache-affinity failover.** Each gateway key remembers its last-good
  provider and tries it first. Failover happens on failure only — the gateway
  never load-balances away from a healthy provider, because rerouting busts
  prompt caches.
- **Retries, then failover.** Within a provider: bounded retries with
  exponential backoff on 429/5xx/connect-timeout/network errors; then the next
  provider in the chain. A 200 response is committed — streamed bytes are
  never re-routed.
- **Per-project JSONL ledger + USD.** One append-only row per completed call:
  tokens, `usd` from per-provider pricing, latency, stream, attempts.
- **Monthly budget caps as hard 402s.** Once a project's month-to-date spend
  reaches its cap, requests are refused with `402` before any upstream call.
- **Key hygiene.** Provider keys come from env vars only (`api_key_env`);
  literal keys are rejected at config load. Gateway keys may be
  `sha256:<hex>`-hashed (`npm run hash-key -- <secret>`); per-key task-class
  allowlists; timing-safe comparison.
- **Observability without a dashboard.** Response headers `x-lg-provider`,
  `x-lg-task-class`, `x-lg-fallback-used`; every served call logged to stdout;
  the `gateway` CLI (`start`/`stop`/`status`/`connect`/`report`); `npm run
  smoke -- <provider-id>|all` probes; an in-process mock provider
  (`"type": "mock"`) for offline proof of the full auth → routing → ledger
  path.

## Measured overhead — one A/B bench session

Paired A/B: identical prompts back-to-back through the gateway vs straight to
the provider. One session, 2026-08-29, one provider (Z.ai), one model
(`glm-5.3-flash`), non-streaming, one box: 60 samples = 30 ordered pairs.

| metric | gateway | direct |
|---|---:|---:|
| latency median | 5.726 s | 5.950 s |
| latency p95 | 30.61 s¹ | 17.36 s |
| token drift | **0 drifted pairs / 27 comparable**² | — |

¹ p95 is dominated by the 3 excluded null-usage gateway rows (~30.6 s each,
pre-dating the nonstream-timeout fix); excluding them: gateway median 5.386 s
(−9.5%), p95 17.27 s vs 17.36 s.
² 3 of 30 pairs excluded — no usage reported on one side. Comparable pairs are
byte-for-byte identical on input and output token counts. Median delta −3.8%
(gateway faster, this run).

Method, provenance, and what would falsify these numbers:
[bench/README.md](bench/README.md) and
[bench/results-2026-08-29.md](bench/results-2026-08-29.md). These are claims
about that session under that configuration — not "zero overhead ever", not
all providers, not streaming. Re-run `bench/bench-ab.sh` to re-establish them
for yours. Running the harness spends provider tokens.

## Guarantees

Behavioral guarantees, each pinned to the test that proves it — the map lives
in [GUARANTEES.md](GUARANTEES.md); the one-line versions:

- **Exactly-once ledger finalize** — one `usage.jsonl` row per request on each
  proven termination path (normal, client disconnect, upstream reset); a fully
  failed chain writes nothing.
- **Torn-write tolerance** — a crash-truncated final ledger line is skipped by
  every reader, and new appends never merge into it.
- **SSE pass-through fidelity** — the client's concatenated stream bytes equal
  the upstream's, delivered incrementally; non-streaming bodies byte-identical.
- **Zero-mutation forwarding** — the upstream body is the client's verbatim
  except the `model` rewrite and usage injection; the gateway key never
  travels upstream.
- **Deadline contract** — `connect_timeout_ms` is a time-to-headers window
  only; once headers arrive a stream is unbounded (this exact bug crashed the
  process once; it is regression-tested).
- **Strict config validation** — all problems reported in one error; literal
  keys are rejected with an `api_key_env` hint and never echoed.
- **Env-only provider keys** — key material is read only from
  `process.env[api_key_env]`; an unset var warns, skips, and the chain
  continues.

## Receipts

`gateway report` reads the ledger directly (no running gateway needed) and
prints a month-to-date receipt: usage per project, counterfactual pricing
comparisons with their assumptions stated inline, and work delivered (tokens
by task class). Flags: `--month YYYY-MM`, `--project <name>`, `--json`,
`--html <out.html>`. No savings number is claimed on this page — every number
that exists carries its method, sample, and source, and the receipt shows them
next to the math.

## Limitations

- The bench is **one provider, one day (2026-08-29), non-streaming, one box**.
  No streaming latency numbers exist.
- The clean-container install timings (bench/install-2026-08-30.md) are **one
  host, one architecture (aarch64), one image digest**, n=3.
- The **curl-pipe install path is unproven** until the repo is public —
  validated so far: running `install.sh` from a checkout (which is what the
  quickstart above does).
- No live-provider proofs in the test suite: every guarantee above is proven
  in-process (mock provider / loopback doubles). See the honest-gaps section
  at the end of [GUARANTEES.md](GUARANTEES.md).

## Configuration reference (`llm-gateway.json`)

| field | default | meaning |
|---|---|---|
| `port`, `host` | `8090`, `127.0.0.1` | listen address (loopback by design) |
| `storage_dir` | `~/.llm-gateway` (or `$LLM_GATEWAY_HOME`) | ledger + sticky state |
| `admin_key` | unset → `/admin/*` returns 503 | guards admin endpoints |
| `connect_timeout_ms` | `10000` | per-attempt time-to-HEADERS window |
| `nonstream_timeout_ms` | `120000` | per-attempt window for non-streaming calls |
| `max_retries_per_provider` | `2` | retries within one provider before failover |
| `retry_backoff_base_ms` | `200` | exponential backoff base |
| `body_limit_mb` | `10` | request body cap |
| `providers` | required | id → `{type, base_url, api_key_env, model_id, pricing{input_per_mtok,output_per_mtok}, task_classes[], stream_include_usage?, off_peak?}` |
| `keys` | required | gateway bearer secret → `{project, allowed_task_classes?[], sticky_provider_hint?}` |
| `routing` | required | taskClass → `[providerId…]` or `{chain, off_peak_chain}`; must contain `"default"` |
| `budgets` | optional | project → `{monthly_usd_cap}` |

Notes:

- Client-facing model IDs are **provider ids** (`"kimi-code"`); the gateway
  rewrites to the provider's upstream `model_id` itself.
- `providers[].api_key_env` is the **name of an environment variable**, never a
  literal key. Omit it entirely for keyless upstreams (e.g. Ollama).
- Empty/omitted `allowed_task_classes` = all classes allowed.
- `stream_include_usage: false` for upstreams that reject `stream_options`
  (Ollama in some versions); when off, streamed token counts are char-estimated
  and ledger rows carry `"estimated": true`.
- `config.example.json` ships approximate placeholder prices — verify against
  each provider's pricing page. Config format is JSON (chosen over YAML to
  stay dependency-free). Per-request task-class override: `X-Task-Class`
  header.

## Not yet implemented (on purpose)

- batch queue / request batching
- dashboards or any UI beyond `GET /admin/usage`
- multi-user auth beyond key→project attribution (no quotas-per-user UI, no RBAC)
- billing/invoicing, alerts, spend notifications (caps are silent hard stops)
- mid-stream failover (impossible without replaying partial output)
- semantic caching, rate limiting, retry-after honoring
- usage estimation refinement (char/4 fallback flagged `estimated`)
- HTTPS/TLS termination (bind loopback; put a proxy in front if you need remote)

## Repo layout

```
src/
  main.ts        entrypoint (arg/env config resolution)
  server.ts      http surface, SSE passthrough + usage tap
  router.ts      pure routing decisions (task class, sticky, allowlist, budget gate, off-peak)
  upstream.ts    dispatch + ordered failover w/ exponential backoff
  report.ts      pure receipt/savings math for `gateway report`
  gatewayctl.ts  gateway connect/report implementation
  mock.ts        in-process provider + failure directives
  ledger.ts      append-only JSONL usage store + aggregation
  keys.ts        bearer verification (plaintext or sha256), timing-safe compare
  storage.ts     sticky-state persistence
  prices.ts      provider price tables (single source for pricing math)
  redact.ts      secret redaction for logs/warnings
  bootstrap.ts   fresh-install config generator
  config.ts      JSON config load/validate (fails listing ALL problems)
bin/
  gateway        launcher: start/stop/status/connect/report
scripts/
  smoke.ts       per-provider live probe
  hash-key.ts    secret -> sha256:<hex>
bench/           A/B harness, summarizer, published results + method
test/            node:test suites, RED-first developed
```

```bash
npm install       # devDeps only (typescript); tests run without it — zero runtime deps
npm test          # node:test — 245 tests / 68 suites
npm run typecheck # tsc --noEmit (strict); needs the install above
```

## License

MIT — see [LICENSE](LICENSE).
