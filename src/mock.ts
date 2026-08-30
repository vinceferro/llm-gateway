/**
 * In-process mock provider (`type: "mock"` in config). No network.
 *
 * Used by the test-suite and usable from real config so the full gateway path
 * works with zero live keys. Behavior directives are embedded in the LAST user
 * message and only honored by the provider they name (or unscoped = any):
 *
 *   [mock:500]                    every provider fails with HTTP 500
 *   [mock@flaky:500]              only provider "flaky" fails with 500
 *   [mock@flaky:429]              only "flaky" fails with 429
 *   [mock@flaky:400]              non-retryable failure
 *   [mock@flaky:fail-first:2]     first two calls fail, then succeed (retry proof)
 *   [mock@flaky:hang]             stall until aborted (connect-timeout proof)
 *   [mock@good:delay:700]         hold the reply 700ms, then succeed (deadline
 *                                 proofs: aborts during the window count as
 *                                 timeout, completion inside it succeeds)
 *   [mock@good:slow-stream:400]   healthy SSE stream, 400ms between chunks
 *                                 (proves connect timeout doesn't kill streams)
 *   [mock@good:no-usage]          omit usage objects (estimation path proof)
 *   [mock@good:cached]            usage carries prompt_tokens_details.cached_tokens
 *                                 (= ceil(input/2); cached-token telemetry proof)
 *   [mock@good:cached:2.5]        usage carries an EXPLICIT cached_tokens value —
 *                                 fractional values simulate a hostile upstream
 *
 * Success replies are deterministic OpenAI-shaped completions ("pong") with
 * token counts derived from the prompt: input = ceil(promptChars/4), output =
 * ceil(len("pong")/4) = 1 — so cost assertions in tests are exact.
 */

import type { ProviderConfig } from "./config.ts";
import { estTokens } from "./util.ts";
import { sleep } from "./util.ts";

export interface UpstreamReply {
  status: number;
  headers?: Record<string, string>;
  /** non-streaming response body */
  bodyText?: string;
  /** streaming response body (SSE bytes) */
  webStream?: ReadableStream<Uint8Array>;
}

interface Directive {
  scope?: string;
  kind: "status" | "hang" | "delay" | "fail-first" | "slow-stream" | "no-usage" | "cached";
  status?: number;
  n?: number;
}

const DIRECTIVE_RE = /\[mock(?:@([A-Za-z0-9_-]+))?:(hang|delay|fail-first|slow-stream|no-usage|cached|\d{3})(?::(\d+(?:\.\d+)?))?\]/g;

function pickDirective(providerId: string, text: string): Directive | null {
  const matches = [...text.matchAll(DIRECTIVE_RE)];
  for (const m of matches) {
    const scope = m[1];
    if (scope !== undefined && scope !== providerId) continue;
    const kindToken = m[2]!;
    if (kindToken === "hang") return { scope, kind: "hang" };
    if (kindToken === "delay") return { scope, kind: "delay", n: Number(m[3] ?? 0) };
    if (kindToken === "fail-first") return { scope, kind: "fail-first", n: Number(m[3] ?? 1) };
    if (kindToken === "slow-stream") return { scope, kind: "slow-stream", n: Number(m[3] ?? 0) };
    if (kindToken === "no-usage") return { scope, kind: "no-usage" };
    if (kindToken === "cached") {
      // explicit value (may be fractional, for hostile-upstream tests); default stays ceil(input/2)
      return { scope, kind: "cached", n: m[3] !== undefined ? Number(m[3]) : undefined };
    }
    return { scope, kind: "status", status: Number(kindToken) };
  }
  return null;
}

const callCounts = new WeakMap<object, number>();

function promptCharsOf(body: Record<string, unknown>): string {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let s = "";
  for (const m of msgs) {
    if (m && typeof m === "object") {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") s += c;
    }
  }
  return s;
}

function mockError(providerId: string, providerModel: string, status: number): UpstreamReply {
  return {
    status,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify({
      error: {
        message: `mock provider "${providerId}" (${providerModel}) forced failure`,
        type: "mock_error",
        code: String(status),
      },
    }),
  };
}

export async function handleMock(
  providerId: string,
  pcfg: ProviderConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<UpstreamReply> {
  const directive = pickDirective(providerId, promptCharsOf(body));

  if (directive?.kind === "hang") {
    // stall until the caller's timeout/client-abort fires
    await new Promise<never>((_resolveP, rejectP) => {
      const t = setTimeout(
        () => rejectP(new Error("mock: hang elapsed without abort")),
        30_000,
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          rejectP(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  if (directive?.kind === "delay") {
    // hold the reply for n ms — but honor an abort arriving mid-window (the
    // caller's attempt deadline), surfacing it as a timeout, not a success
    const ms = directive.n ?? 0;
    await new Promise<void>((resolveP, rejectP) => {
      if (signal.aborted) {
        rejectP(new DOMException("aborted", "AbortError"));
        return;
      }
      const t = setTimeout(resolveP, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          rejectP(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  if (directive?.kind === "status") {
    return mockError(providerId, pcfg.model_id, directive.status ?? 500);
  }

  if (directive?.kind === "fail-first") {
    const n = directive.n ?? 1;
    const count = (callCounts.get(pcfg) ?? 0) + 1;
    callCounts.set(pcfg, count);
    if (count <= n) return mockError(providerId, pcfg.model_id, 500);
  }

  const model = pcfg.model_id;
  const inTok = estTokens(promptCharsOf(body));
  const content = "pong";
  const outTok = estTokens(content);
  const includeUsage = directive?.kind !== "no-usage";
  const cachedTokens =
    directive?.kind === "cached"
      ? directive.n !== undefined
        ? directive.n
        : Math.ceil(inTok / 2)
      : undefined;
  const usage = {
    prompt_tokens: inTok,
    completion_tokens: outTok,
    total_tokens: inTok + outTok,
    ...(cachedTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
  };

  if (body.stream !== true) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: JSON.stringify({
        id: `chatcmpl-mock-${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        ...(includeUsage ? { usage } : {}),
      }),
    };
  }

  // streaming: role chunk, content chunks, final (usage) chunk, [DONE].
  // slow-stream mode drips ONE CHARACTER per frame with a delay between frames.
  const enc = new TextEncoder();
  const base = {
    id: `chatcmpl-mock-${Date.now().toString(36)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const frame = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`;
  const slow = directive?.kind === "slow-stream" ? (directive.n ?? 0) : 0;
  const contentChunks = slow > 0 ? content.split("") : (content.match(/.{1,2}/g) ?? [content]);
  const frames: string[] = [];
  frames.push(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
  for (const c of contentChunks) {
    frames.push(frame({ ...base, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] }));
  }
  const finalObj: Record<string, unknown> = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  if (includeUsage) finalObj.usage = usage;
  frames.push(frame(finalObj));
  frames.push("data: [DONE]\n\n");

  if (slow > 0) {
    let i = 0;
    let cancelled = false;
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      webStream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cancelled || i >= frames.length) {
            controller.close();
            return;
          }
          const f = frames[i++]!;
          await sleep(slow);
          controller.enqueue(enc.encode(f));
        },
        cancel() {
          cancelled = true;
        },
      }),
    };
  }

  const payload = frames.join("");
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(payload));
      controller.close();
    },
  });
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    webStream,
  };
}
