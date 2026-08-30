/**
 * Shared test helpers: temp storage dirs, canned configs, server lifecycle.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type { GatewayConfig, ProviderConfig } from "../src/config.ts";
import { createGatewayServer } from "../src/server.ts";

export function tmpDir(prefix = "lg-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Deterministic mock provider config. pricing defaults: $0.50 in / $2.00 out per Mtok. */
export function mockProvider(id: string, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: "mock",
    model_id: `${id}-model`,
    pricing: { input_per_mtok: 0.5, output_per_mtok: 2 },
    task_classes: [],
    ...over,
  };
}

export interface TestConfigOptions {
  routing?: Record<string, string[]>;
  budgets?: GatewayConfig["budgets"];
  /** null = admin_key deliberately unset (admin endpoints must 503) */
  adminKey?: string | null;
  /** allowed_task_classes for the test key */
  allowed?: string[];
  connect_timeout_ms?: number;
  /** per-attempt time-to-headers/body window for NON-streaming requests (default 120000 in production) */
  nonstream_timeout_ms?: number;
}

export const TEST_KEY = "sk-test-key-1";

export function makeConfig(opts: TestConfigOptions = {}, dir: string): GatewayConfig {
  const key: GatewayConfig["keys"][string] = { project: "proj-a" };
  if (opts.allowed) key.allowed_task_classes = opts.allowed;
  return {
    port: 0,
    host: "127.0.0.1",
    storage_dir: dir,
    admin_key: opts.adminKey === null ? undefined : (opts.adminKey ?? "admin-secret"),
    connect_timeout_ms: opts.connect_timeout_ms ?? 300,
    ...(opts.nonstream_timeout_ms !== undefined ? { nonstream_timeout_ms: opts.nonstream_timeout_ms } : {}),
    max_retries_per_provider: 2,
    retry_backoff_base_ms: 5,
    body_limit_mb: 10,
    providers: {
      flaky: mockProvider("flaky"),
      good: mockProvider("good"),
      alt: mockProvider("alt"),
    },
    keys: { [TEST_KEY]: key },
    routing: opts.routing ?? { bulk: ["flaky", "good"], default: ["good"] },
    budgets: opts.budgets ?? {},
  };
}

export interface RunningServer {
  server: http.Server;
  port: number;
  url: string;
  storageDir: string;
  close: () => Promise<void>;
}

/** Optional server seams for deterministic tests. `now` fixes the routing clock. */
export interface ServerOptions {
  now?: () => Date;
}

export function startServer(cfg: GatewayConfig, storageDir: string, opts: ServerOptions = {}): Promise<RunningServer> {
  const server = createGatewayServer(cfg, opts);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (c) => {
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
  });
  return new Promise((resolveP) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveP({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        storageDir,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

export interface ChatResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json?: unknown;
}

export async function chat(
  port: number,
  key: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<ChatResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* streaming responses aren't JSON */
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}

export function readJsonl(path: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait until predicate passes (for post-stream async ledger writes). */
export async function waitFor<T>(fn: () => T | undefined | null, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
