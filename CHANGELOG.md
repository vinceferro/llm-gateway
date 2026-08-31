# Changelog

All notable changes to llm-gateway. Honest entries only: what changed,
what it costs you, and what to check after upgrading.

## 0.2.0 — 2026-08-31

Features:

- **Capability-aware routing.** Providers can declare `capabilities`
  (`vision`, `tools`, `reasoning`) in config; unspecified means the
  capability is *not claimed*. Requests containing images
  (`image_url` parts) are routed only to providers that claim vision —
  filtered in the chain's configured order (sticky, failure-only
  semantics unchanged). If a class has no vision-capable provider, the
  request is rejected with `422 capability_error` **before dispatch**;
  nothing is sent upstream and no ledger row is written.
- **`/v1/models` now advertises `capabilities`** per model (resolved
  values, `false` when unclaimed) so clients can adapt.
- **`gateway connect --project [name]`** mints or selects a per-repo
  gateway key (default name: current directory's basename), so usage
  attribution and budget caps bind per repo with one command.

Upgrade notes:

- If you send image requests through a chain whose providers don't
  declare `capabilities: { vision: true }`, those requests now fail
  fast with a clear 422 instead of silently landing on a
  possibly-blind model. Add the declaration to the providers that can
  actually see — don't claim it speculatively.
- Text-only requests are byte-for-byte unchanged, including configs
  where no provider declares any capabilities.

## 0.1.0 — 2026-08-30

Initial public-ready state: OpenAI-compatible local gateway with
task-class routing, sticky cache-affinity failover (failure-only),
per-project JSONL usage ledger in USD, monthly budget caps as hard
402s, one-command installer, and GUARANTEES.md mapping each contract
to the test that proves it.
