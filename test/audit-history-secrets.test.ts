/**
 * RED-first tests for scripts/audit-history-secrets.py — full-history secrets audit.
 *
 * The script is python3-stdlib-only and must be network-incapable: the only
 * subprocess it may spawn is `git cat-file --batch-all-objects --batch`
 * (local object-DB read). Same spawn-a-script pattern as bootstrap.test.ts
 * (which spawns src/bootstrap.ts / install.sh).
 *
 * Fixtures are throwaway git repos built in a tmpdir via subprocess git.
 * Planted secrets are generated AT RUNTIME (randomBytes) so no secret-shaped
 * literal is ever committed into this repo's own history or test source, and
 * the planted VALUE is never asserted to appear in the audit output — only
 * its absence is.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { cleanupDir } from "./helpers.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "audit-history-secrets.py");
const PYTHON = "python3";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
};

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=audit-fixture@example.invalid", "-c", "user.name=audit-fixture", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: GIT_ENV, stdio: "pipe", timeout: 30_000 },
  );
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-hist-"));
  git(dir, "init", "-q", "--initial-branch=main");
  return dir;
}

function commitFile(repo: string, name: string, content: string): void {
  writeFileSync(join(repo, name), content);
  git(repo, "add", "--", name);
  git(repo, "commit", "-qm", `add ${name}`);
}

interface AuditRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runAudit(cwd: string, ...candidatePaths: string[]): AuditRun {
  const r = spawnSync(PYTHON, [SCRIPT, ...candidatePaths], { cwd, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Runtime-generated fake secret: shape `sk-test-<24 hex>` (matches sk-[A-Za-z0-9_-]{16,}). */
function fakeSkSecret(): string {
  return "sk-test-" + randomBytes(12).toString("hex");
}

/** Runtime-generated candidate that matches NO generic pattern (forces the candidate path). */
function fakeOpaqueCandidate(): string {
  return "kimi-" + randomBytes(8).toString("hex"); // len 21, alnum+dash, letters+digits
}

function benignEnvFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-cand-"));
  const p = join(dir, "benign.env");
  writeFileSync(p, "export GATEWAY_PORT=8090\nexport LOG_LEVEL=info\n");
  return p;
}

describe("audit-history-secrets: findings", () => {
  it("flags a generic sk-shaped secret in history: exit 1, location reported, value never printed", () => {
    const repo = initRepo();
    const secret = fakeSkSecret();
    try {
      commitFile(repo, "notes.txt", `provider token: ${secret}\nall good otherwise\n`);
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert.match(combined, /findings=[1-9]/, "summary must report the finding count");
        assert.match(combined, /FINDING/, "must contain a FINDING line");
        assert.match(combined, /pattern=sk_prefix/, "finding must name the pattern");
        assert.match(combined, /object=[0-9a-f]{40}/, "finding must report the git object id (location)");
        assert.match(combined, /match_sha256=[0-9a-f]+/, "finding carries a hash of matched bytes, not the bytes");
        assert.ok(!combined.includes(secret), "the secret VALUE must never appear in stdout or stderr");
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("finds candidate values from env-file and JSON candidate files (exact-value search), value never printed", () => {
    const repo = initRepo();
    const v1 = fakeOpaqueCandidate();
    const v2 = fakeOpaqueCandidate();
    try {
      commitFile(repo, "a.txt", `hardcoded: ${v1}\n`);
      commitFile(repo, "cfg.json", JSON.stringify({ gateway_key: v2 }));
      const candDir = mkdtempSync(join(tmpdir(), "audit-cand-"));
      const envPath = join(candDir, "env");
      const jsonPath = join(candDir, "keys.json");
      writeFileSync(envPath, `export PROVIDER_KEY=${v1}\nexport HARMLESS=8.1.1\n`);
      writeFileSync(jsonPath, JSON.stringify({ keys: { gw: v2 }, note: "local issuer" }));
      try {
        const r = runAudit(repo, envPath, jsonPath);
        assert.equal(r.status, 1, `expected exit 1\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert.match(combined, /candidates_checked=2/, "both secret-bearing values must be collected");
        assert.match(combined, /findings=2/, "both planted values must be located");
        assert.match(combined, /FINDING candidate=/, "candidate findings are labelled as such");
        assert.ok(!combined.includes(v1) && !combined.includes(v2), "candidate VALUES must never appear in output");
      } finally {
        cleanupDir(candDir);
      }
    } finally {
      cleanupDir(repo);
    }
  });
});

describe("audit-history-secrets: exemptions are loud, never silent", () => {
  it("placeholder-shaped literals are counted as benign_literals, not findings (exit 0)", () => {
    const repo = initRepo();
    try {
      commitFile(repo, "config.example.json", JSON.stringify({ keys: { "sk-lg-demo-CHANGE-ME": { project: "demo" } } }));
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 0, `expected exit 0\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /benign_literals=1/);
        assert.match(r.stdout, /EXEMPT bucket=benign_literals/);
        assert.match(r.stdout, /RESULT: CLEAN/);
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("repo's own `pragma: allowlist secret` convention exempts a fixture line (exit 0)", () => {
    const repo = initRepo();
    try {
      commitFile(repo, "fixture.txt", 'api_key = "sk-live-SUPERSECRETVALUE123" // pragma: allowlist secret — validator must reject\n');
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 0, `expected exit 0\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /allowlisted=1/);
        assert.match(r.stdout, /RESULT: CLEAN/);
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("a labeled digest (sha256:…64hex) is a receipt, not a credential: hash_receipts bucket (exit 0)", () => {
    const repo = initRepo();
    try {
      commitFile(repo, "receipt.md", `verified: sha256:${randomBytes(32).toString("hex")}\n`);
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 0, `expected exit 0\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /hash_receipts=1/);
        assert.match(r.stdout, /EXEMPT bucket=hash_receipts/);
        assert.match(r.stdout, /RESULT: CLEAN/);
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });
});

describe("audit-history-secrets: known_fixture bucket (operator-ratified 2026-08-30)", () => {
  /**
   * A generic-pattern finding whose matched VALUE exactly equals a value that
   * appears AT HEAD on a line carrying `pragma: allowlist secret` is
   * classified known_fixture: still LISTED individually (never silent), but it
   * does not fail the audit. Exit 0 only when EVERY finding is known_fixture.
   * Candidate values always take precedence — a hit on a real candidate value
   * is never downgraded, period.
   */
  it("a value pragma-declared at HEAD is listed as known_fixture and exits 0 (exact-value match)", () => {
    const repo = initRepo();
    const secret = fakeSkSecret();
    try {
      commitFile(repo, "notes.txt", `provider token: ${secret}\n`); // history: no pragma
      commitFile(repo, "fixture.txt", `provider token: ${secret} // pragma: allowlist secret\n`); // HEAD: declared
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 0, `expected exit 0 (all findings known_fixture)\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /known_fixture=1/, "summary must count the known_fixture bucket");
        assert.match(r.stdout, /findings=0/, "known_fixture must not count as a plain finding");
        assert.match(r.stdout, /FINDING bucket=known_fixture/, "known_fixture findings are still LISTED individually, never silent");
        assert.match(r.stdout, /EXEMPT bucket=allowlisted/, "line-local pragma at HEAD still buckets as allowlisted");
        assert.match(r.stdout, /RESULT: CLEAN/);
        assert.ok(!r.stdout.includes(secret), "the matched VALUE must never appear in output");
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("a NEIGHBORING value (one char different) NOT pragma-declared at HEAD still fails: exit 1", () => {
    const repo = initRepo();
    const secret = fakeSkSecret();
    // exactly one hex char flipped: same shape, DIFFERENT value → must not match the known set
    const neighbor =
      secret.slice(0, 8) + (secret[8] === "0" ? "1" : "0") + secret.slice(9);
    assert.notEqual(neighbor, secret);
    try {
      commitFile(repo, "notes.txt", `a: ${secret}\nb: ${neighbor}\n`); // both without pragma in history
      commitFile(repo, "fixture.txt", `a: ${secret} // pragma: allowlist secret\n`); // only `secret` declared at HEAD
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 1, `neighbor must NOT be downgraded — expected exit 1\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /findings=1/, "exactly the undeclared neighbor remains a plain finding");
        assert.match(r.stdout, /known_fixture=1/, "the pragma-declared value is still bucketed known_fixture");
        assert.match(r.stdout, /FINDING pattern=sk_prefix/, "the neighbor is a plain, loud FINDING");
        assert.match(r.stdout, /RESULT: FINDINGS PRESENT/);
        assert.ok(!r.stdout.includes(secret) && !r.stdout.includes(neighbor), "values must never appear in output");
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("candidate precedence: a real candidate value that is ALSO pragma-marked at HEAD is never downgraded (exit 1)", () => {
    const repo = initRepo();
    const cand = fakeSkSecret(); // sk-shaped → matches sk_prefix AND is collectible as a candidate
    try {
      commitFile(repo, "head.txt", `key: ${cand} // pragma: allowlist secret\n`);
      const candDir = mkdtempSync(join(tmpdir(), "audit-cand-"));
      const envPath = join(candDir, "env");
      writeFileSync(envPath, `export PROVIDER_KEY=${cand}\n`);
      try {
        const r = runAudit(repo, envPath);
        assert.equal(r.status, 1, `candidate hit must never be downgraded — expected exit 1\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /findings=1/, "the candidate hit is a finding, period");
        assert.match(r.stdout, /candidates_hit=1/, "counted under candidates_hit");
        assert.match(r.stdout, /FINDING candidate=/, "reported as a candidate FINDING");
        assert.match(r.stdout, /allowlisted=0/, "a real candidate value is NEVER presented as exempt/downgraded");
        assert.ok(!/EXEMPT bucket=allowlisted/.test(r.stdout), "no allowlisted-EXEMPT line may describe the candidate value");
        assert.ok(!r.stdout.includes(cand), "the candidate VALUE must never appear in output");
      } finally {
        cleanupDir(candDir);
      }
    } finally {
      cleanupDir(repo);
    }
  });
});

describe("audit-history-secrets: hygiene", () => {
  it("clean repo exits 0 with findings=0", () => {
    const repo = initRepo();
    try {
      commitFile(repo, "readme.txt", "just prose, nothing secret\n");
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 0, `expected exit 0\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /findings=0/);
        assert.match(r.stdout, /RESULT: CLEAN/);
        assert.match(r.stdout, /objects_scanned=[1-9]/, "must have scanned the history blob(s)");
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("oversize blobs (>5 MiB) are skipped and counted, never scanned", () => {
    const repo = initRepo();
    const secret = fakeSkSecret();
    try {
      const big = "A".repeat(5 * 1024 * 1024) + "\n" + secret + "\n"; // 5 MiB + secret → over cap
      commitFile(repo, "big.bin", big);
      const env = benignEnvFile();
      try {
        const r = runAudit(repo, env);
        assert.equal(r.status, 0, `oversize blob must be SKIPPED (exit 0)\nstdout:${r.stdout}\nstderr:${r.stderr}`);
        assert.match(r.stdout, /objects_skipped_oversize=1/);
        assert.match(r.stdout, /findings=0/);
        assert.ok(!(r.stdout + r.stderr).includes(secret), "skipped blob's content must not surface");
      } finally {
        rmSync(env, { force: true });
        rmSync(join(env, ".."), { recursive: true, force: true });
      }
    } finally {
      cleanupDir(repo);
    }
  });

  it("usage errors exit 2: no args, nonexistent candidate file", () => {
    const repo = initRepo();
    try {
      const noArgs = runAudit(repo);
      assert.equal(noArgs.status, 2, "no candidate args must be a usage error");
      assert.match(noArgs.stderr, /usage: audit-history-secrets/, "must print the script's own usage text");
      const missing = runAudit(repo, join(repo, "does-not-exist.env"));
      assert.equal(missing.status, 2, "missing candidate file must be a usage error");
      assert.match(missing.stderr, /candidate file not found/, "must name the failure reason");
    } finally {
      cleanupDir(repo);
    }
  });

  it("network-incapable by construction: runtime selfcheck proves `import socket` is refused", () => {
    // The script disables network modules in its own process; `import socket`
    // then raises ImportError — proof the audit process cannot open sockets.
    const self = spawnSync(PYTHON, [SCRIPT, "--selfcheck-net"], { encoding: "utf8", timeout: 30_000 });
    assert.equal(self.status, 0, `selfcheck failed\nstdout:${self.stdout}\nstderr:${self.stderr}`);
    assert.match(self.stdout, /network-io: BLOCKED/);
  });

  it("static source assertions: only fixed-argv `git cat-file` subprocesses; no exec/eval of blobs", () => {
    const src = readFileSync(SCRIPT, "utf8");
    assert.match(src, /Popen\(\s*\[\s*"git",\s*"cat-file",\s*"--batch-all-objects",\s*"--batch"/, "spawn 1 must be the fixed local all-blobs git argv");
    assert.match(src, /Popen\(\s*\[\s*"git",\s*"cat-file",\s*"--batch"\]/, "spawn 2 must be the fixed local HEAD-walk git argv (allowlist harvest)");
    assert.equal((src.match(/Popen\(/g) ?? []).length, 2, "exactly two Popen calls in the script — both fixed git cat-file argvs");
    assert.ok(!/subprocess\.(run|check_output|check_call|call)\(/.test(src), "no other subprocess helpers allowed");
    assert.ok(!/(^|[^a-z])exec\(/.test(src) && !/(^|[^a-z])eval\(/.test(src), "blob content is never executed");
    // the network-block mechanism must actually be present (runtime proof is the selfcheck above)
    assert.match(src, /sys\.modules\[_m\]\s*=\s*None/, "network modules must be disabled via sys.modules poisoning");
  });
});
