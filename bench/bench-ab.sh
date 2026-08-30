#!/usr/bin/env bash
# bench-ab.sh — controlled A/B: gateway vs direct provider, identical prompts.
# Behavioral port of the machine-local harness that produced the published
# 2026-08-29 numbers (same prompts, same curl flags, same JSONL row schema,
# same error-row format). The only differences are parameterization:
#   BENCH_GATEWAY_URL  required  e.g. http://127.0.0.1:8090/v1/chat/completions
#   BENCH_DIRECT_URL   required  provider chat-completions endpoint
#   BENCH_GATEWAY_KEY  required  gateway bearer key
#   BENCH_DIRECT_KEY   required  provider bearer key
#   BENCH_MODEL        required  model id sent in both arms
#   BENCH_PASSES       optional  loop count over the prompt set (default 1)
# Usage: bench-ab.sh <out.jsonl>
# Appends one JSON line per request: {arm,kind,pass,latency_s,in,out,cached} — keys never printed.
# NOTE: hits real endpoints and spends tokens — running it is operator-gated.
set -euo pipefail

usage() {
  echo "usage: BENCH_GATEWAY_URL=... BENCH_DIRECT_URL=... BENCH_GATEWAY_KEY=... \\" >&2
  echo "       BENCH_DIRECT_KEY=... BENCH_MODEL=... [BENCH_PASSES=N] $0 <out.jsonl>" >&2
}

[ $# -eq 1 ] || { usage; exit 1; }
OUT="$1"

missing=""
for v in BENCH_GATEWAY_URL BENCH_DIRECT_URL BENCH_GATEWAY_KEY BENCH_DIRECT_KEY BENCH_MODEL; do
  if [ -z "${!v:-}" ]; then
    echo "missing required env: $v" >&2
    missing=1
  fi
done
[ -z "$missing" ] || { usage; exit 1; }

GW="$BENCH_GATEWAY_URL"
DIRECT="$BENCH_DIRECT_URL"
GW_KEY="$BENCH_GATEWAY_KEY"
DIRECT_KEY="$BENCH_DIRECT_KEY"
MODEL="$BENCH_MODEL"
PASSES="${BENCH_PASSES:-1}"
[[ "$PASSES" =~ ^[1-9][0-9]*$ ]] || { echo "BENCH_PASSES must be a positive integer (got a value of the wrong shape; values are never printed)" >&2; exit 1; }

PROMPTS=(
  "tiny|8|Answer with exactly one word: what color is the sky on a clear day?"
  "tiny|8|Answer with exactly one word: what is 2+2?"
  "tiny|8|Answer with exactly one word: name the capital of Japan."
  "med|300|Write a Python function that merges two sorted lists into one sorted list. Include a short docstring. No examples."
  "med|300|Write a bash one-liner that finds the 10 largest files under a directory tree. Explain each part in one sentence."
  "med|300|Write a SQL query that returns the top 5 customers by total order value from tables customers(id,name) and orders(id,customer_id,total). Brief explanation."
  "med|300|Write a regex that matches ISO-8601 dates (YYYY-MM-DD). Explain the parts briefly."
  "long|700|Explain how prompt caching reduces LLM costs and latency for agentic coding tools. Cover: prefix reuse, cache-hit pricing, staleness, and one concrete workflow example. ~300 words."
  "long|700|Explain the tradeoffs between sticky routing and load balancing for LLM gateways. Cover: prompt cache economics, provider failover, cost. ~300 words."
  "long|700|Draft a short project status update for a client whose AI feature build is on track, budget stable, with one risk noted. Professional tone, ~250 words."
)

run_one() {
  local arm="$1" url="$2" auth="$3" kind="$4" pass="$5" mt="$6" prompt="$7"
  local body resp ttotal jsonb
  body="$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"max_tokens":int(sys.argv[2]),"messages":[{"role":"user","content":sys.argv[3]}]}))' "$MODEL" "$mt" "$prompt")"
  if ! resp="$(curl -s --max-time 60 -w '\n%{time_total}' -X POST "$url" -H "Authorization: Bearer $auth" -H "Content-Type: application/json" -d "$body")"; then
    echo "{\"arm\":\"$arm\",\"kind\":\"$kind\",\"pass\":$pass,\"error\":\"request_failed\"}" >> "$OUT"; return
  fi
  ttotal="$(tail -1 <<< "$resp")"
  jsonb="$(head -n -1 <<< "$resp")"
  python3 - "$arm" "$kind" "$pass" "$ttotal" "$jsonb" <<'PY' >> "$OUT"
import json, sys
arm, kind = sys.argv[1], sys.argv[2]
pass_, ttotal, body = int(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
try:
    j = json.loads(body)
    u = j.get("usage") or {}
    print(json.dumps({"arm": arm, "kind": kind, "pass": pass_,
                      "latency_s": round(ttotal, 3),
                      "in": u.get("prompt_tokens"), "out": u.get("completion_tokens"),
                      "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens")}))
except Exception as e:
    print(json.dumps({"arm": arm, "kind": kind, "pass": pass_, "error": str(e)[:80]}))
PY
}

for ((pass=1; pass<=PASSES; pass++)); do
  for p in "${PROMPTS[@]}"; do
    IFS='|' read -r kind mt prompt <<< "$p"
    run_one gateway "$GW" "$GW_KEY" "$kind" "$pass" "$mt" "$prompt"
    run_one direct "$DIRECT" "$DIRECT_KEY" "$kind" "$pass" "$mt" "$prompt"
  done
done
echo "bench complete: $(grep -c '"arm"' "$OUT") samples in $OUT"
