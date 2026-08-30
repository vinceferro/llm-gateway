# bench/ — gateway A/B methodology and published results

Tools to measure what the gateway **costs** you: paired requests through the
gateway vs straight to the provider, identical prompts, back to back. This
directory is bench-only tooling — it is not part of the gateway runtime, not
exercised by `npm test` (except the summarizer's pure logic), and running the
harness **spends provider tokens** (SPEND is operator-gated).

## What is compared

Two arms, same prompt, same `max_tokens`, same model, issued one after the
other:

- **gateway** — `POST {BENCH_GATEWAY_URL}` through the local gateway
- **direct** — `POST {BENCH_DIRECT_URL}` straight to the provider

Three prompt kinds: `tiny` (one-word answers, `max_tokens` 8), `med` (short
code/SQL/regex answers, 300), `long` (~300-word explanations, 700).
Non-streaming only. The harness appends one JSONL row per request:

```json
{"arm":"gateway","kind":"tiny","pass":1,"latency_s":0.902,"in":28,"out":8,"cached":0}
```

`in`/`out`/`cached` are the provider-reported usage numbers
(`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`);
`null` when the response carried no usage. On transport failure the harness
writes `{"arm":...,"kind":...,"pass":...,"error":"request_failed"}` instead.

## How to run

Keys come from env vars only — they are never written to disk by the harness
and never printed. Requires bash, curl, python3.

```bash
# 1) run the bench — SPENDS TOKENS on both arms; operator-gated
BENCH_GATEWAY_URL=http://127.0.0.1:8090/v1/chat/completions \
BENCH_DIRECT_URL=https://api.z.ai/api/coding/paas/v4/chat/completions \
BENCH_GATEWAY_KEY=<gateway key> \
BENCH_DIRECT_KEY=<provider key> \
BENCH_MODEL=glm-5.3-flash \
BENCH_PASSES=3 \
bench/bench-ab.sh /tmp/results.jsonl

# 2) summarize — local, free, zero-dependency
npm run bench:summarize -- /tmp/results.jsonl       # JSON to stdout
npm run bench:summarize -- /tmp/results.jsonl --md  # compact markdown
```

Missing required env → the script lists the missing names and exits 1 before
sending anything.

## Metric definitions

- **Pairing** — the harness writes gateway-then-direct per prompt and the JSONL
  carries no prompt id, so `bench/summarize.ts` pairs rows by **(pass,
  ordinal-within-pass)**: the 2i-th row of a pass pairs with its (2i+1)-th.
  Error rows keep their ordinal, so a failed side becomes an *incomplete pair*
  rather than shifting later pairs. Pairing never crosses passes.
- **Token drift** — per pair, `in`/`out`/`cached` are compared only when both
  sides report the metric (null usage on either side ⇒ pair *excluded* from
  drift, never counted as drift). `drifted_pairs` = comparable pairs where any
  metric differs; `max_delta` = max absolute per-metric delta.
- **Latency** — `time_total` from curl, per arm over all its latency-bearing
  rows (not per pair). Median and p95 by linear interpolation between closest
  ranks.
- **Median delta %** — `(gateway median − direct median) / direct median ×
  100`; negative = gateway faster.

## The published session (2026-08-29) — sample size and structure

One benchmark session, one box, one provider (Z.ai), one model
(`glm-5.3-flash`), non-streaming — not one clean run. It comprised two harness
invocations (an aborted attempt — 10 pairs, 3 of whose gateway rows returned
no usage after ~30.6 s timeout-class responses — plus a full re-run), then a
third clean pass. 60 rows = **30 ordered pairs**: `pass=1` holds the aborted
attempt and the re-run (20 pairs), `pass=2` the clean pass (10 pairs). Pairing
is mechanical, so all 30 pairs are analyzed as written; nothing was
hand-deleted. Provenance caveat: the 3 excluded null-usage gateway rows
predate the non-stream deadline fix (2026-08-29), so the headline stats mix two
gateway builds — symmetrically across both arms, so neither arm is favored.

Results (generated, see `results-2026-08-29.md`; JSON via `npm run
bench:summarize -- bench/results-2026-08-29.jsonl`):

- **Token drift: 0 drifted pairs** across the 27 comparable pairs (3 excluded:
  no usage on one side). Input and output token counts are identical on all 27
  comparable pairs. `cached` was 0 on every row that reports usage, in both
  arms (null on the 3 excluded rows) — there was no cache-hit activity anywhere
  in this run, so the `cached` comparison is 0 == 0: this bench says nothing
  about cache behavior through the gateway either way.
- **Latency, this run only.** Gateway median 5.726 s vs direct 5.950 s
  (**−3.8%**). Gateway p95 30.61 s vs direct 17.36 s — the gateway p95 is
  dominated by the 3 excluded null-usage rows (~30.6 s each). Excluding those
  3 rows: gateway median 5.386 s (−9.5% vs direct median), gateway p95 17.27 s
  vs direct 17.36 s. Per kind (gateway vs direct): tiny 0.962 vs 0.977 s, med
  5.726 vs 5.950 s, long 17.367 vs 15.807 s. No dispersion statistic or CI
  was computed for this run; the numbers above are all that exists.

## Falsification

These claims are falsifiable per run. What would kill them:

- **"Zero token drift" dies** if any comparable pair — same prompt, same pass,
  both sides reporting usage — shows any difference: `|Δ| ≥ 1` on `in`, `out`,
  or `cached`. A single such pair anywhere (`drifted_pairs ≥ 1` in the
  summarizer output) disproves the claim for that configuration. `cached`
  drift is the most important case: the direct arm reporting `cached > 0`
  while the gateway arm reports `cached = 0` on the same prompt would mean the
  gateway path breaks provider prompt-cache hits — the gateway's core
  economics would be falsified, not just this claim.
- **Any latency-parity claim dies** if the median delta is reproducibly and
  materially against the gateway — e.g. repeated runs with gateway median >10%
  above direct across kinds — or if gateway p95 stays inflated *without* the
  timeout-class rows (added-hop cost the gateway cannot explain away).
- **What does NOT falsify either claim:** the 3 no-usage rows (request
  failures, not drift — though a *pattern* of them would falsify gateway
  reliability), single-request spikes, streaming workloads (out of scope
  here), other providers or models, other boxes.
- **The harness does not fail loudly:** `bench-ab.sh` exits 0 even when every
  request fails (faithful to the original harness), so an all-failure run
  would still summarize as "0 drifted". Always check the sample count in the
  summary output before quoting results.

## Scope — read before quoting

All numbers above come from **ONE benchmark session on 2026-08-29**: one
provider (Z.ai), one model (`glm-5.3-flash`), non-streaming only, 60 samples /
30 ordered pairs, on one box, both arms sharing machine and network. The "zero
token drift" claim and the latency numbers above are claims **about that
session under that configuration** — not "zero overhead ever", not all
providers, not streaming. Re-run the harness to re-establish them for your
configuration.
