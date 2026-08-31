/**
 * Entrypoint: `npm run dev` (or `node --experimental-strip-types src/main.ts`).
 * Config path: --config <file> | LLM_GATEWAY_CONFIG | ./llm-gateway.json
 */

import { createGatewayServer } from "./server.ts";
import { configPath, configFilePermWarning, loadConfig, ConfigError } from "./config.ts";
import { redactLong } from "./redact.ts";

function main(): void {
  let cfg;
  let usedPath: string;
  try {
    usedPath = configPath(process.argv);
    cfg = loadConfig(usedPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[lg] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  // config holds gateway keys — flag loose file perms (Finding: README promised this)
  const permWarning = configFilePermWarning(usedPath);
  if (permWarning) console.warn(`[lg] WARNING ${permWarning}`);

  // warn early about providers whose key env vars are missing (they'll be skipped at request time)
  for (const [id, p] of Object.entries(cfg.providers)) {
    if (p.type === "mock") continue;
    if (p.api_key_env && !process.env[p.api_key_env]) {
      console.warn(
        `[lg] WARNING provider "${id}" env var ${redactLong(p.api_key_env)} is not set — it will be SKIPPED by routing until you export it`,
      );
    }
  }

  const server = createGatewayServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[lg] llm-gateway v0.2.0 listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[lg] providers: ${Object.keys(cfg.providers).join(", ")}`);
    console.log(`[lg] storage:   ${cfg.storage_dir}`);
    console.log(`[lg] config:    ${usedPath}`);
  });

  const shutdown = (): void => {
    console.log("[lg] shutting down…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
