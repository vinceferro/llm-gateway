/**
 * HTTP surface (OpenAI-compatible):
 *
 *   POST /v1/chat/completions   gateway-key auth; task class via X-Task-Class
 *                               header (unknown/absent -> default chain); model
 *                               field may pin a provider id; full SSE pass-through
 *   GET  /v1/models             configured providers as model ids
 *   GET  /admin/usage           ?project=&month=YYYY-MM (admin_key auth)
 *   GET  /healthz
 */

import http from "node:http";
import { Readable } from "node:stream";
import type { GatewayConfig } from "./config.ts";
import { providerCapabilities } from "./config.ts";
import { bearerFrom, verifySecret } from "./keys.ts";
import {
  appendRecord,
  computeCost,
  monthSpend,
  summarizeLedger,
  type UsageRecord,
} from "./ledger.ts";
import { requiresVision, resolveChain, isClassAllowed, budgetExceeded, resolveTaskClass } from "./router.ts";
import { currentMonth, estTokens, estTokensFromChars, nowIso } from "./util.ts";
import { loadSticky, saveSticky, type StickyMap } from "./storage.ts";
import { executeWithFailover, UpstreamError, ClientAbortedError } from "./upstream.ts";

interface UsagePair {
  input: number;
  output: number;
  /** upstream-reported cached prompt tokens; undefined when unreported (never estimated) */
  cached?: number;
}

/** OpenAI-compatible usage shape that may carry prompt-cache details. */
interface UpstreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: unknown };
}

/**
 * Cached prompt tokens from a usage object; undefined unless upstream reported
 * a finite, INTEGER, non-negative number (UsageRecord documents int >= 0 — a
 * fractional value from a hostile upstream is garbage, not a measurement;
 * Number.isInteger(2.0) is true, so a whole-number float still passes).
 * Absent/garbage → omitted, no estimate: cached input is materially cheaper,
 * so fabricating would misstate economics.
 */
function cachedTokensOf(u: UpstreamUsage | undefined): number | undefined {
  const v = u?.prompt_tokens_details?.cached_tokens;
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0
    ? v
    : undefined;
}

/** Byte-exact SSE passthrough that taps usage objects and content deltas from data: lines. */
function sseUsageTap(src: ReadableStream<Uint8Array>): {
  out: ReadableStream<Uint8Array>;
  getUsage: () => UsagePair | undefined;
  /** total assistant content chars seen (for honest token estimation, ignoring SSE framing) */
  contentChars: () => number;
  /** epoch ms of the FIRST upstream byte observed; undefined until one arrives (ttfb source) */
  firstByteAt: () => number | undefined;
  /** epoch ms of the LAST upstream byte observed (stream window end) */
  lastByteAt: () => number | undefined;
} {
  let usage: UsagePair | undefined;
  let contentChars = 0;
  let firstByteAt: number | undefined;
  let lastByteAt: number | undefined;
  const dec = new TextDecoder();
  let buf = "";
  const scan = (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data) as {
          usage?: UpstreamUsage;
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const u = obj.usage;
        if (u && typeof u.prompt_tokens === "number") {
          const cached = cachedTokensOf(u);
          usage = {
            input: u.prompt_tokens,
            output: u.completion_tokens ?? 0,
            ...(cached !== undefined ? { cached } : {}),
          };
        }
        for (const c of obj.choices ?? []) {
          if (typeof c.delta?.content === "string") contentChars += c.delta.content.length;
        }
      } catch {
        /* not JSON — ignore */
      }
    }
  };
  const out = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // passive telemetry: timestamp only — no buffering, no cadence change
        const at = Date.now();
        if (firstByteAt === undefined) firstByteAt = at;
        lastByteAt = at;
        scan(dec.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        scan(dec.decode());
      },
    }),
  );
  return {
    out,
    getUsage: () => usage,
    contentChars: () => contentChars,
    firstByteAt: () => firstByteAt,
    lastByteAt: () => lastByteAt,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
  type = "gateway_error",
  extra?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { message, type, code: status, ...extra } });
}

function headerVal(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function readBody(req: http.IncomingMessage, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > limitBytes) throw new Error(`body exceeds ${limitBytes} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function promptChars(body: { messages?: unknown }): string {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let s = "";
  for (const m of msgs) {
    const c = (m as { content?: unknown } | null)?.content;
    if (typeof c === "string") s += c;
  }
  return s;
}

/**
 * Optional seams, mostly for deterministic tests. `now` fixes the routing
 * clock (off-peak chain selection + [lg] window note); production omits it.
 */
export interface GatewayServerOptions {
  now?: () => Date;
}

export function createGatewayServer(cfg: GatewayConfig, opts: GatewayServerOptions = {}): http.Server {
  const storageDir = cfg.storage_dir;
  const sticky: StickyMap = loadSticky(storageDir);

  function findKey(presented: string): { keyId: string; keyCfg: GatewayConfig["keys"][string] } | null {
    for (const [keyId, keyCfg] of Object.entries(cfg.keys)) {
      if (verifySecret(keyId, presented)) return { keyId, keyCfg };
    }
    return null;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true, version: "0.2.0" });
      return;
    }

    if (path === "/v1/models" && req.method === "GET") {
      const key = bearerFrom(req.headers);
      if (!key || !findKey(key)) return sendError(res, 401, "missing or unknown gateway key", "authentication_error");
      sendJson(res, 200, {
        object: "list",
        data: Object.entries(cfg.providers).map(([id, p]) => ({
          id,
          object: "model",
          owned_by: id,
          task_classes: p.task_classes,
          pricing: p.pricing,
          // resolved claim set — false when the config doesn't claim it (shared source of truth with routing: providerCapabilities)
          capabilities: providerCapabilities(p),
        })),
      });
      return;
    }

    if (path.startsWith("/admin/") && req.method === "GET") {
      return handleAdmin(req, res, url);
    }

    if (path === "/v1/chat/completions") {
      if (req.method !== "POST") return sendError(res, 405, "method not allowed");
      return handleChat(req, res);
    }

    sendError(res, 404, `no route: ${req.method} ${path}`);
  }

  async function handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const presented = bearerFrom(req.headers);
    const found = presented ? findKey(presented) : null;
    if (!found) return sendError(res, 401, "missing or unknown gateway key", "authentication_error");
    const { keyId, keyCfg } = found;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req, cfg.body_limit_mb * 1024 * 1024)) as Record<string, unknown>;
    } catch (e) {
      return sendError(res, 400, `invalid request body: ${(e as Error).message}`, "invalid_request_error");
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, "'messages' must be a non-empty array", "invalid_request_error");
    }

    const headerTaskClass = headerVal(req.headers["x-task-class"]);
    const tc = resolveTaskClass(cfg.routing, { headerValue: headerTaskClass });

    // pinned provider (model == provider id) still honors the class allowlist
    if (!isClassAllowed(keyCfg, tc.taskClass)) {
      return sendError(
        res,
        403,
        `task class "${tc.taskClass}" is not allowed for this key (allowed: ${
          keyCfg.allowed_task_classes?.join(", ") || "*"
        })`,
        "permission_error",
      );
    }

    // hard monthly budget gate (per project)
    const cap = cfg.budgets[keyCfg.project]?.monthly_usd_cap;
    const month = currentMonth();
    if (cap !== undefined && budgetExceeded(monthSpend(storageDir, keyCfg.project, month), cap)) {
      return sendError(
        res,
        402,
        `monthly budget cap reached for project "${keyCfg.project}": spent $${monthSpend(storageDir, keyCfg.project, month)} of $${cap} cap for ${month}. Requests are hard-stopped until the cap is raised.`,
        "budget_exceeded",
      );
    }

    const decision = resolveChain(cfg, sticky, keyId, keyCfg, {
      taskClass: tc.taskClass,
      model: body.model,
      now: opts.now?.(),
      requiresVision: requiresVision(body),
    });
    // capability gate fired before any dispatch: explicit 422, never a silent downgrade
    if (decision.capabilityError) {
      return sendError(res, 422, decision.capabilityError, "capability_error");
    }
    if (decision.chain.length === 0) {
      return sendError(res, 502, `empty routing chain for task class "${tc.taskClass}"`, "config_error");
    }

    const startedAt = Date.now();
    const clientAbort = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) clientAbort.abort();
    });

    let served: Awaited<ReturnType<typeof executeWithFailover>>;
    try {
      served = await executeWithFailover(cfg, decision.chain, body, clientAbort.signal);
    } catch (e) {
      if (e instanceof ClientAbortedError) {
        res.destroy();
        return;
      }
      if (e instanceof UpstreamError) {
        console.error(
          `[lg] FAIL project=${keyCfg.project} class=${tc.taskClass} chain=[${decision.chain.join(" -> ")}] attempts=${JSON.stringify(e.attemptLog)}`,
        );
        return sendError(res, 502, e.message, "upstream_error", { attempts: e.attemptLog });
      }
      throw e;
    }

    // Non-streaming TTFB: executeWithFailover resolves on upstream response
    // receipt (headers + full body for buffered replies), so this delta is the
    // upstream-response receipt time. Streaming TTFB is measured separately at
    // the first upstream byte (see sseUsageTap). Recorded as ttfb_ms on both paths.
    const responseReceiptAt = Date.now();

    // success -> stickiness moves/holds here (failure-only routing rule)
    sticky[keyId] = served.providerId;
    saveSticky(storageDir, sticky);

    const headers: Record<string, string> = {
      "x-lg-provider": served.providerId,
      "x-lg-task-class": tc.taskClass,
      "x-lg-fallback-used": String(served.fallbackUsed),
    };
    if (tc.unknownClass && headerTaskClass) {
      headers["x-lg-note"] = `unknown task class "${headerTaskClass}" routed via default chain`;
    }

    interface Timings {
      ttfb_ms?: number;
      stream_ms?: number;
    }

    const recordRow = (
      usage: UsagePair,
      stream: boolean,
      estimated: boolean,
      latencyMs: number,
      incomplete = false,
      timings: Timings = {},
    ): void => {
      const pcfg = cfg.providers[served.providerId]!;
      const rec: UsageRecord = {
        ts: nowIso(),
        project: keyCfg.project,
        provider: served.providerId,
        model: pcfg.model_id,
        task_class: tc.taskClass,
        input_tokens: usage.input,
        output_tokens: usage.output,
        usd: computeCost(pcfg.pricing, usage.input, usage.output),
        latency_ms: latencyMs,
        stream,
        fallback_used: served.fallbackUsed,
        attempts: served.attempts,
        ...(usage.cached !== undefined ? { cached_tokens: usage.cached } : {}),
        ...(timings.ttfb_ms !== undefined ? { ttfb_ms: timings.ttfb_ms } : {}),
        ...(timings.stream_ms !== undefined ? { stream_ms: timings.stream_ms } : {}),
        ...(estimated ? { estimated: true } : {}),
        ...(incomplete ? { incomplete: true } : {}),
      };
      appendRecord(storageDir, rec);
      console.log(
        `[lg] ${rec.ts} project=${rec.project} provider=${rec.provider} model=${rec.model} class=${rec.task_class} stream=${String(rec.stream)} tokens=${rec.input_tokens}/${rec.output_tokens}${rec.cached_tokens !== undefined ? ` cached=${rec.cached_tokens}` : ""} usd=$${rec.usd} latency=${rec.latency_ms}ms${rec.ttfb_ms !== undefined ? ` ttfb=${rec.ttfb_ms}ms` : ""}${rec.stream_ms !== undefined ? ` stream_ms=${rec.stream_ms}` : ""} fallback=${String(rec.fallback_used)} attempts=${rec.attempts}${decision.offPeakApplied ? " window=off-peak" : ""}${rec.estimated ? " estimated" : ""}${rec.incomplete ? " INCOMPLETE" : ""}`,
      );
    };

    if (served.reply.webStream) {
      const tapped = sseUsageTap(served.reply.webStream);
      res.writeHead(200, {
        ...headers,
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const upstreamStream = Readable.fromWeb(tapped.out);
      let finalized = false;
      const finalize = (failed: boolean): void => {
        if (finalized) return;
        finalized = true;
        const usage =
          tapped.getUsage() ??
          ({
            input: estTokens(promptChars(body)),
            output: estTokensFromChars(tapped.contentChars()),
          } satisfies UsagePair);
        // ttfb_ms = request start -> first upstream byte; stream_ms = first ->
        // last upstream byte (generation window). A stream that fails before
        // its first byte records no perf fields — same shape as old rows.
        const first = tapped.firstByteAt();
        const last = tapped.lastByteAt();
        const timings: Timings = {};
        if (first !== undefined) {
          timings.ttfb_ms = Math.max(0, first - startedAt);
          if (last !== undefined) timings.stream_ms = Math.max(0, last - first);
        }
        recordRow(usage, true, !tapped.getUsage(), Date.now() - startedAt, failed, timings);
      };
      // Mid-stream failures (upstream reset, tap error, abort) must end THIS
      // response, still record the ledger row, and never crash the process.
      upstreamStream.on("error", (err: Error) => {
        console.error("[lg] stream failed mid-flight:", err.message);
        finalize(true);
        if (!res.writableEnded) {
          try {
            res.end();
          } catch {
            /* client already gone */
          }
        }
      });
      upstreamStream.pipe(res);
      res.on("finish", () => finalize(false));
      res.on("close", () => {
        if (!res.writableEnded) {
          // client disconnected mid-stream: cancel the upstream body too
          upstreamStream.destroy();
          finalize(true);
        } else {
          finalize(false);
        }
      });
      return;
    }

    // non-streaming
    const latencyMs = Date.now() - startedAt;
    let usage: UsagePair | undefined;
    let completionChars = "";
    try {
      const json = JSON.parse(served.reply.bodyText ?? "{}") as {
        usage?: UpstreamUsage;
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      if (typeof json.usage?.prompt_tokens === "number") {
        const cached = cachedTokensOf(json.usage);
        usage = {
          input: json.usage.prompt_tokens,
          output: json.usage.completion_tokens ?? 0,
          ...(cached !== undefined ? { cached } : {}),
        };
      }
      const c = json.choices?.[0]?.message?.content;
      if (typeof c === "string") completionChars = c;
    } catch {
      /* opaque body — estimate below */
    }
    const estimated = !usage;
    recordRow(
      usage ?? { input: estTokens(promptChars(body)), output: estTokens(completionChars) },
      false,
      estimated,
      latencyMs,
      false,
      { ttfb_ms: Math.max(0, responseReceiptAt - startedAt) },
    );

    res.writeHead(200, { ...headers, "content-type": served.reply.headers?.["content-type"] ?? "application/json" });
    res.end(served.reply.bodyText);
  }

  function handleAdmin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): void {
    if (!cfg.admin_key) {
      return sendError(res, 503, "admin endpoints disabled: admin_key not configured");
    }
    const presented = bearerFrom(req.headers);
    if (!presented || !verifySecret(cfg.admin_key, presented)) {
      return sendError(res, 401, "missing or unknown admin key", "authentication_error");
    }
    if (url.pathname !== "/admin/usage") {
      return sendError(res, 404, `no admin route: ${url.pathname}`);
    }
    const project = url.searchParams.get("project") ?? undefined;
    const month = url.searchParams.get("month") ?? currentMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return sendError(res, 400, "month must be YYYY-MM", "invalid_request_error");
    }
    const summary = summarizeLedger(storageDir, { project, month });
    sendJson(res, 200, { month, project: project ?? "*", ...summary });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error("[lg] internal error:", e);
      if (!res.headersSent) sendError(res, 500, "internal gateway error");
      else res.destroy();
    });
  });
  return server;
}
