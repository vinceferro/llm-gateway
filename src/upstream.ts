/**
 * Upstream dispatch + ordered failover.
 *
 * Policy (per brief):
 *  - retry the SAME provider up to `max_retries_per_provider` times with
 *    exponential backoff (base * 2^attempt) before moving on
 *  - retryable: HTTP 429, HTTP 5xx, connect timeout, network error
 *  - non-retryable (other 4xx, missing provider API key env): advance to next
 *    provider immediately
 *  - once an upstream responds 200 the response is COMMITTED — no mid-stream
 *    failover (SSE bytes may already be on the wire)
 */

import type { GatewayConfig, ProviderConfig } from "./config.ts";
import { DEFAULT_NONSTREAM_TIMEOUT_MS } from "./config.ts";
import { handleMock, type UpstreamReply } from "./mock.ts";
import { sleep } from "./util.ts";

export class ClientAbortedError extends Error {
  constructor() {
    super("client disconnected");
  }
}

export interface AttemptInfo {
  provider: string;
  outcome: string | number; // 200 | 4xx/5xx code | "timeout" | "network" | "env-missing"
  detail?: string;
}

export class UpstreamError extends Error {
  readonly attemptLog: AttemptInfo[];
  constructor(
    message: string,
    attemptLog: AttemptInfo[],
  ) {
    super(message);
    this.attemptLog = attemptLog;
  }
}

function joinUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/chat/completions";
}

/** Single attempt against one configured provider. Throws on transport failure. */
export async function dispatchOne(
  providerId: string,
  pcfg: ProviderConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<UpstreamReply> {
  if (pcfg.type === "mock") return handleMock(providerId, pcfg, body, signal);

  let apiKey: string | undefined;
  if (pcfg.api_key_env !== undefined) {
    apiKey = process.env[pcfg.api_key_env];
    if (!apiKey) {
      // config problem, not a transient fault — caller advances without retrying
      const err = new Error(`environment variable ${pcfg.api_key_env} is not set`);
      err.name = "EnvMissingError";
      throw err;
    }
  }

  const payload: Record<string, unknown> = { ...body, model: pcfg.model_id };
  const streaming = payload.stream === true;
  if (
    streaming &&
    pcfg.stream_include_usage !== false &&
    !(payload.stream_options as { include_usage?: boolean } | undefined)?.include_usage
  ) {
    payload.stream_options = { include_usage: true };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(joinUrl(pcfg.base_url!), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    return { status: res.status, bodyText: text };
  }
  if (streaming && res.body) {
    return { status: res.status, webStream: res.body };
  }
  return { status: res.status, bodyText: await res.text() };
}

function isAbort(e: unknown): boolean {
  const err = e as { name?: string; code?: string };
  return err?.name === "AbortError" || err?.name === "TimeoutError" || err?.code === "ABORT_ERR";
}

export interface FailoverSuccess {
  providerId: string;
  reply: UpstreamReply;
  /** total upstream attempts across the whole chain */
  attempts: number;
  fallbackUsed: boolean;
  chainHead: string;
  attemptLog: AttemptInfo[];
}

export async function executeWithFailover(
  cfg: Pick<
    GatewayConfig,
    "providers" | "connect_timeout_ms" | "nonstream_timeout_ms" | "max_retries_per_provider" | "retry_backoff_base_ms"
  >,
  chain: string[],
  body: Record<string, unknown>,
  clientSignal?: AbortSignal,
): Promise<FailoverSuccess> {
  const attemptLog: AttemptInfo[] = [];
  const maxAttemptsPerProvider = 1 + cfg.max_retries_per_provider;
  // Deadline policy: a STREAMING upstream sends headers early, so the connect
  // deadline fits. A NON-streaming upstream sends headers+body together at
  // completion — a healthy long generation would blow the connect window —
  // so non-stream requests get their own, much longer, window.
  const isStream = body.stream === true;
  const deadlineMs = isStream
    ? cfg.connect_timeout_ms
    : (cfg.nonstream_timeout_ms ?? DEFAULT_NONSTREAM_TIMEOUT_MS);

  for (let i = 0; i < chain.length; i++) {
    const providerId = chain[i]!;
    const pcfg = cfg.providers[providerId];
    if (!pcfg) continue;

    for (let attempt = 0; attempt < maxAttemptsPerProvider; attempt++) {
      if (clientSignal?.aborted) throw new ClientAbortedError();

      // Connect-phase deadline ONLY: the timer is cleared as soon as
      // dispatchOne resolves (upstream headers/body available). It must never
      // stay attached to a streaming response body — long-lived SSE streams
      // would otherwise be killed mid-flight.
      const attemptAbort = new AbortController();
      const timer = setTimeout(
        () => attemptAbort.abort(new DOMException("connect timeout", "TimeoutError")),
        deadlineMs,
      );
      const onClientAbort = () => attemptAbort.abort(new DOMException("client disconnected", "AbortError"));
      clientSignal?.addEventListener("abort", onClientAbort, { once: true });
      attemptLog.push({ provider: providerId, outcome: "pending" });
      const logEntry = attemptLog[attemptLog.length - 1]!;

      let reply: UpstreamReply;
      try {
        reply = await dispatchOne(providerId, pcfg, body, attemptAbort.signal);
      } catch (e) {
        if (!(e instanceof Error) && clientSignal?.aborted) throw new ClientAbortedError();
        if ((e as Error).name === "EnvMissingError") {
          logEntry.outcome = "env-missing";
          logEntry.detail = (e as Error).message; // names the exact env var
          break; // advance to next provider immediately
        }
        if (clientSignal?.aborted) throw new ClientAbortedError();
        if (isAbort(e)) {
          logEntry.outcome = "timeout";
          logEntry.detail = `no response within ${deadlineMs}ms`;
        } else {
          logEntry.outcome = "network";
          logEntry.detail = (e as Error).message;
        }
        if (attempt < maxAttemptsPerProvider - 1) {
          await sleep(cfg.retry_backoff_base_ms * 2 ** attempt);
        }
        continue;
      } finally {
        clearTimeout(timer); // headers/body arrived or attempt failed — stop the connect deadline
        clientSignal?.removeEventListener("abort", onClientAbort);
      }

      logEntry.outcome = reply.status;
      if (reply.status === 200) {
        return {
          providerId,
          reply,
          attempts: attemptLog.length,
          fallbackUsed: i > 0 || providerId !== chain[0],
          chainHead: chain[0]!,
          attemptLog,
        };
      }

      const retriable = reply.status === 429 || reply.status >= 500;
      if (!retriable) break; // advance to next provider immediately
      if (attempt < maxAttemptsPerProvider - 1) {
        await sleep(cfg.retry_backoff_base_ms * 2 ** attempt);
      }
    }
  }

  throw new UpstreamError(
    `all ${chain.length} upstream provider(s) in the chain failed`,
    attemptLog,
  );
}
