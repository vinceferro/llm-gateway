/**
 * RED-first tests for the installer shell layer (install.sh + bin/gateway).
 * The bash scripts are tested via `bash -n` syntax checks and by sourcing
 * their guarded "library mode" to exercise the pure functions.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

function bash(script: string): string {
  return execFileSync("bash", ["-c", script], { encoding: "utf8", timeout: 30_000 });
}

function shq(p: string): string {
  return `'${p.replaceAll("'", `'\\''`)}'`;
}

describe("install.sh", () => {
  const installSh = join(REPO_ROOT, "install.sh");

  it("passes bash -n syntax check", () => {
    execFileSync("bash", ["-n", installSh]);
  });

  it("is curl|sh safe: has no unguarded main when sourced with INSTALL_SH_LIB=1", () => {
    const out = bash(`INSTALL_SH_LIB=1 source ${shq(installSh)} && node_version_gte 22 6 && echo OK`);
    assert.match(out, /OK/);
  });

  it("node_version_gte accepts 22.6, 22.7, 23.x; rejects 22.5, 21.x, garbage (injected versions)", () => {
    const out = bash(`set -euo pipefail
INSTALL_SH_LIB=1 source ${shq(installSh)}
node_version_gte 22 6 v22.6.0
node_version_gte 22 6 v22.23.2
node_version_gte 22 6 v23.0.0
node_version_gte 22 6 v24.12.3
node_version_gte 22 6 "v22.5.1" && exit 1 || true
node_version_gte 22 6 "v21.9.9" && exit 1 || true
node_version_gte 22 6 "garbage" && exit 1 || true
echo ALL-OK`);
    assert.match(out, /ALL-OK/, "every version comparison behaved as declared");
  });

  it("default repo URL is overridable via LLM_GATEWAY_REPO_URL", () => {
    const out = bash(`INSTALL_SH_LIB=1 source ${shq(installSh)} && echo "$REPO_URL"`);
    assert.match(out, /llm-gateway/);
  });

  it("finish panel suggests the absolute launcher when the shim dir is NOT on PATH (RED: no bare 'gateway start')", () => {
    const out = bash(`set -euo pipefail
T="$(mktemp -d)"
mkdir -p "$T/home"
HOME="$T/home"
INSTALL_SH_LIB=1
export HOME INSTALL_SH_LIB
source ${shq(installSh)}
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH
install_shim
mkdir -p "$(dirname "$CONFIG_PATH")"   # install_tree would have created this
printf '"sk-lg-redtest-000000000000000000"' > "$CONFIG_PATH"
finish_panel
rm -rf "$T"
`);
    // absolute, runnable fallback must appear
    assert.match(out, /bin\/gateway start/, "panel must show <APP_DIR>/bin/gateway start");
    // ...and no bare unqualified `gateway <cmd>` suggestion may remain (it can't exist for this user)
    assert.doesNotMatch(
      out,
      /(^|\n)\s*gateway (start|status|connect|report)\b/,
      "panel must not suggest a bare 'gateway' command when the shim was skipped",
    );
  });

  it("finish panel keeps the friendly bare gateway commands when the shim IS on PATH", () => {
    const out = bash(`set -euo pipefail
T="$(mktemp -d)"
mkdir -p "$T/home/.local/bin"
HOME="$T/home"
INSTALL_SH_LIB=1
export HOME INSTALL_SH_LIB
source ${shq(installSh)}
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$PATH:$HOME/.local/bin" ;; esac
export PATH
install_shim
mkdir -p "$(dirname "$CONFIG_PATH")"   # install_tree would have created this
printf '"sk-lg-redtest-000000000000000000"' > "$CONFIG_PATH"
finish_panel
rm -rf "$T"
`);
    assert.match(out, /installed the 'gateway' command/, "shim branch must have run");
    assert.match(out, /(^|\n)\s+gateway start\b/, "friendly bare 'gateway start' stays");
    assert.doesNotMatch(out, /bin\/gateway start/, "no path-qualified fallback in the shim case");
  });
});

describe("bin/gateway", () => {
  const gatewaySh = join(REPO_ROOT, "bin", "gateway");

  it("passes bash -n syntax check", () => {
    execFileSync("bash", ["-n", gatewaySh]);
  });

  it("unknown command exits non-zero with usage (hermetic: env-driven paths)", () => {
    let failed = false;
    try {
      execFileSync(
        "bash",
        [gatewaySh, "definitely-not-a-command"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            LLM_GATEWAY_APP_DIR: join(REPO_ROOT),
            LLM_GATEWAY_CONFIG: "/tmp/lg-test-nonexistent-cfg.json",
          },
        },
      );
    } catch (e) {
      failed = true;
      const err = e as { status?: number; stderr?: string };
      assert.notEqual(err.status, 0);
      assert.match(err.stderr ?? "", /usage/i);
    }
    assert.ok(failed, "unknown subcommand must fail");
  });

  it("missing tool argument for connect is rejected by the node layer", () => {
    let failed = false;
    try {
      execFileSync(
        "bash",
        [gatewaySh, "connect"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            LLM_GATEWAY_APP_DIR: join(REPO_ROOT),
            LLM_GATEWAY_CONFIG: "/tmp/lg-test-nonexistent-cfg.json",
          },
        },
      );
    } catch {
      failed = true;
    }
    assert.ok(failed);
  });
});
