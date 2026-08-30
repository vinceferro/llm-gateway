#!/usr/bin/env python3
"""audit-history-secrets.py — prove no secret material in git history.

Run from a repo root: scans EVERY blob object in the local object database
(`git cat-file --batch-all-objects --batch`) for secret-shaped literals and
for the exact values of candidate secrets supplied as files (env files and
JSON). Pure local stdlib work; exit 0 clean / 1 findings / 2 usage error.

INVARIANTS (each is regression-tested in test/audit-history-secrets.test.ts):
- Network-incapable: after stdlib imports, network-capable modules are
  disabled by poisoning sys.modules (import socket → ImportError). The ONLY
  subprocesses are two fixed-argv `git cat-file` reads of the LOCAL object
  database — `--batch-all-objects --batch` (every blob) and `--batch` (HEAD
  tree walk to harvest the HEAD allowlist): no URL, no remote, no fetch, no
  shell, ever.
- Blob content is matched in memory only: never executed, never written to
  disk, and never printed. Findings carry the object id, byte offset and a
  truncated sha256 of the matched bytes — never the bytes themselves.
- Oversize blobs (> 5 MiB) are counted and SKIPPED, not scanned (bounded
  compute; a hostile huge blob can't stall the audit).

EXEMPTION BUCKETS (self-evident non-secrets — reported loudly, never silent;
a bucketed match is counted and listed but does not fail the audit):
- benign_literals: matched value carries a placeholder marker
  (change-me / example / dummy / redtest / …) or a ≥8 run of one character
  (all-zero test keys have no entropy).
- allowlisted: the repo's own convention — the matched line carries
  `pragma: allowlist secret` (existing fixture marker in this repo).
- hash_receipts: the match immediately follows a digest label
  (sha256:/sha1:/sha512:/md5:) — a labeled digest is a receipt, not a
  credential. (Reproducibility receipts otherwise fail every audit forever.)

KNOWN-FIXTURE BUCKET (operator-ratified 2026-08-30):
- known_fixture: a generic-pattern finding whose matched value EXACTLY equals
  a value that appears AT HEAD on a line carrying `pragma: allowlist secret`.
  The allowlist lives in the repo at HEAD — auditable, not a side file — so
  pre-pragma history revisions of a documented fixture stop failing the audit
  forever. Semantics: known_fixture findings are STILL LISTED individually in
  the report (never silent); exit 0 ONLY when every finding is known_fixture;
  any other finding → exit 1. Line-local `allowlisted` classification is
  unchanged and takes precedence (it is stricter evidence).

Candidate values from the given files are matched by EXACT bytes, and an
exact candidate hit is ALWAYS a finding — no bucket exempts it. Candidate
values take PRECEDENCE over every bucket: an occurrence of a real candidate
value is never classified allowlisted/known_fixture/etc. — it is reported
exactly once, as a FINDING candidate= line.
"""

import hashlib
import json
import os
import re
import subprocess
import sys

# --- network incapability: poison every network-capable stdlib module -------
for _m in ("socket", "ssl", "http", "urllib", "ftplib", "smtplib", "telnetlib", "nntplib", "xmlrpc"):
    sys.modules[_m] = None  # any later `import socket` (etc.) raises ImportError

MAX_BLOB_BYTES = 5 * 1024 * 1024  # bounded compute: blobs above this are skipped + counted

USAGE = "usage: audit-history-secrets.py [--selfcheck-net] <candidate-file> [<candidate-file> ...]"

# Generic secret-shaped patterns (simple, linear — no nested quantifiers).
PATTERNS = (
    ("sk_prefix", re.compile(rb"sk-[A-Za-z0-9_-]{16,}")),
    ("ghp_token", re.compile(rb"ghp_[A-Za-z0-9]{30,}")),
    ("hex40plus", re.compile(rb"[A-Fa-f0-9]{40,}")),
    ("bearer_token", re.compile(rb"Bearer [A-Za-z0-9._-]{25,}")),
)

# Candidate-collection shapes.
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$")
_QUOTED = re.compile(r"^(['\"])(.*)\1$")
# A value is "secret-bearing" if it matches a generic pattern, or is a long
# token (>=20 chars, credential charset, mixed letters+digits, no whitespace).
_HIGH_ENTROPY = re.compile(rb"[A-Za-z0-9_\-./+=]{20,}")

# Exemption shapes.
_BENIGN_MARKER = re.compile(rb"(?i)(change-?me|example|placeholder|dummy|redtest|sample|xxxxx)")
_SAME_CHAR_RUN = re.compile(rb"(.)\1{7,}")  # ≥8 identical chars: no entropy (linear, no nesting)
_DIGEST_LABEL = re.compile(rb"(?i)(sha\d{1,3}|md5)\s*[:=][ \t]*$")
_PRAGMA = b"pragma: allowlist secret"


def usage_fail(reason: str) -> "None":
    print(f"audit-history-secrets: {reason}", file=sys.stderr)
    print(USAGE, file=sys.stderr)
    raise SystemExit(2)


def selfcheck_net() -> int:
    """Runtime proof of the network-incapability invariant (test hook)."""
    for module in ("socket", "ssl"):
        try:
            __import__(module)
        except ImportError:
            continue
        print(f"network-io: FAILED ({module} importable — block is broken)", file=sys.stderr)
        return 3
    print("network-io: BLOCKED (import socket/ssl refused in this process)")
    return 0


# --- candidate collection (values are held only as bytes, never printed) ----

def _add_candidate(raw: str, values: list, seen: set) -> None:
    m = _QUOTED.match(raw.strip())
    v = m.group(2) if m else raw.strip()
    if not v:
        return
    b = v.encode("utf-8", "replace")
    if not (any(p.search(b) for _, p in PATTERNS)
            or (_HIGH_ENTROPY.fullmatch(b) and any(c.isalpha() for c in v) and any(c.isdigit() for c in v))):
        return
    tag = hashlib.sha256(b).hexdigest()[:16]
    if tag not in seen:
        seen.add(tag)
        values.append((tag, b))


def _walk_json(node: object, values: list, seen: set) -> None:
    if isinstance(node, dict):
        for v in node.values():
            _walk_json(v, values, seen)
    elif isinstance(node, list):
        for v in node:
            _walk_json(v, values, seen)
    elif isinstance(node, str):
        _add_candidate(node, values, seen)


def collect_candidates(path: str, values: list, seen: set) -> None:
    if not os.path.isfile(path):
        usage_fail(f"candidate file not found: {path}")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            data = json.loads(stripped)
        except ValueError:
            usage_fail(f"candidate file is not valid JSON: {path}")
        _walk_json(data, values, seen)
        return
    env_lines = 0
    loose: list = []
    for line in stripped.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _ENV_LINE.match(line)
        if m:
            env_lines += 1
            _add_candidate(m.group(2), values, seen)
        else:
            loose.append(line)
    if not env_lines and len(loose) == 1:
        _add_candidate(loose[0], values, seen)  # raw single-token key file


# --- blob streaming (the only subprocess; fixed local argv) -----------------

def _read_exact(stream, n: int) -> bytes:
    parts, remaining = [], n
    while remaining > 0:
        chunk = stream.read(min(remaining, 1 << 20))
        if not chunk:
            raise RuntimeError("truncated object stream from git cat-file")
        parts.append(chunk)
        remaining -= len(chunk)
    return b"".join(parts)


def iter_blobs(stats: dict):
    """Yield (oid_hex, content_bytes) for every blob ≤ MAX_BLOB_BYTES.

    stats gains objects_scanned / objects_skipped_oversize / non_blob counts.
    """
    proc = subprocess.Popen(
        ["git", "cat-file", "--batch-all-objects", "--batch"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    assert proc.stdout is not None
    try:
        while True:
            header = proc.stdout.readline()
            if header == b"":
                break
            parts = header.split()
            if len(parts) != 3 or not parts[2].isdigit():
                raise RuntimeError(f"unexpected cat-file header: {header[:60]!r}")
            oid, otype, size = parts[0].decode(), parts[1].decode(), int(parts[2])
            if otype != "blob":  # commits/trees/tags: out of scope (blobs are the content)
                _read_exact(proc.stdout, size + 1)
                stats["non_blob"] = stats.get("non_blob", 0) + 1
                continue
            if size > MAX_BLOB_BYTES:
                _read_exact(proc.stdout, size + 1)  # trailing \n separator
                stats["skipped"] += 1
                continue
            yield oid, _read_exact(proc.stdout, size)
            _read_exact(proc.stdout, 1)  # trailing \n separator
            stats["scanned"] += 1
    finally:
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"git cat-file exited {code} (run from a repo root)")


# --- matching ---------------------------------------------------------------

def harvest_head_allowlist(known: set) -> None:
    """Add to `known` every value pattern-matched on a HEAD line that carries
    the allowlist pragma. Walks the HEAD tree via `git cat-file --batch` —
    a fixed argv, local object-DB read (the allowlist is auditable AT HEAD,
    never taken from the mutable working tree). Values are held as bytes only,
    never printed.
    """
    proc = subprocess.Popen(
        ["git", "cat-file", "--batch"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    assert proc.stdin is not None and proc.stdout is not None

    def request(name: str):
        """One batch request → (type, content) or None if the object is absent."""
        proc.stdin.write(name.encode() + b"\n")
        proc.stdin.flush()
        header = proc.stdout.readline()
        if header == b"":
            raise RuntimeError("truncated object stream from git cat-file")
        parts = header.split()
        if len(parts) == 2 and parts[1] == b"missing":
            return None
        if len(parts) != 3 or not parts[2].isdigit():
            raise RuntimeError(f"unexpected cat-file header: {header[:60]!r}")
        raw = _read_exact(proc.stdout, int(parts[2]) + 1)  # content + LF separator
        return parts[1].decode(), raw[:-1]

    try:
        head = request("HEAD")
        if head is None or head[0] != "commit":
            return  # unborn HEAD / detached oddity: no allowlist, plain behavior
        first = head[1].split(b"\n", 1)[0]
        if not first.startswith(b"tree "):
            return
        queue, seen_trees = [first.split()[1].decode()], set()
        while queue:
            t_oid = queue.pop()
            if t_oid in seen_trees:
                continue
            seen_trees.add(t_oid)
            res = request(t_oid)
            if res is None or res[0] != "tree":
                continue
            data = res[1]
            i = 0
            while i < len(data):
                j = data.index(b"\0", i)
                mode, name = data[i:j].decode("utf-8", "replace").split(" ", 1)
                oid = data[j + 1:j + 21].hex()
                i = j + 21
                if mode in ("40000", "040000"):
                    queue.append(oid)
                elif mode in ("100644", "100755", "120000"):
                    bres = request(oid)
                    if bres is None or bres[0] != "blob" or len(bres[1]) > MAX_BLOB_BYTES:
                        continue
                    for line in bres[1].splitlines():
                        if _PRAGMA in line:
                            for _, pat in PATTERNS:
                                for m in pat.finditer(line):
                                    known.add(m.group(0))
    finally:
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"git cat-file exited {code} (run from a repo root)")


def classify(name: str, val: bytes, line: bytes, before: bytes) -> str:
    if _PRAGMA in line:
        return "allowlisted"
    if name != "candidate" and _DIGEST_LABEL.search(before):
        return "hash_receipts"
    if _BENIGN_MARKER.search(val) or _SAME_CHAR_RUN.search(val):
        return "benign_literals"
    return "finding"


def scan_blob(oid: str, blob: bytes, candidates: list, candidate_values: set, known: set, counts: dict) -> None:
    for pname, pattern in PATTERNS:
        for m in pattern.finditer(blob):
            val = m.group(0)
            if val in candidate_values:
                # Candidate precedence (ratified): a real candidate value is
                # never bucketed/downgraded — reported exactly once, below.
                continue
            ls = blob.rfind(b"\n", 0, m.start()) + 1
            le = blob.find(b"\n", m.end())
            if le == -1:
                le = len(blob)
            bucket = classify(pname, val, blob[ls:le], blob[ls:m.start()])
            if bucket == "finding" and val in known:
                bucket = "known_fixture"
            h = hashlib.sha256(val).hexdigest()[:16]
            counts[bucket] += 1
            if bucket == "finding":
                print(f"FINDING pattern={pname} object={oid} offset={m.start()} match_sha256={h}")
            elif bucket == "known_fixture":
                print(f"FINDING bucket=known_fixture pattern={pname} object={oid} offset={m.start()} match_sha256={h}")
            else:
                print(f"EXEMPT bucket={bucket} pattern={pname} object={oid} match_sha256={h}")
    for tag, cval in candidates:
        start = 0
        while True:
            i = blob.find(cval, start)
            if i == -1:
                break
            counts["finding"] += 1
            counts["candidates_hit"] += 1
            print(f"FINDING candidate={tag} object={oid} offset={i}")
            start = i + 1


def main(argv: list) -> int:
    args = argv[1:]
    if args == ["--selfcheck-net"]:
        return selfcheck_net()
    if not args or any(a.startswith("-") for a in args):
        usage_fail("need candidate files (and no other flags)" if args else "no candidate files given")

    values, seen = [], set()
    for path in args:
        collect_candidates(path, values, seen)

    known: set = set()
    harvest_head_allowlist(known)

    counts = {
        "finding": 0, "benign_literals": 0, "allowlisted": 0, "hash_receipts": 0,
        "known_fixture": 0, "candidates_hit": 0,
    }
    stats = {"scanned": 0, "skipped": 0}
    candidate_values = {v for _, v in values}
    for oid, blob in iter_blobs(stats):
        scan_blob(oid, blob, values, candidate_values, known, counts)
    print(
        f"SUMMARY objects_scanned={stats['scanned']} objects_skipped_oversize={stats['skipped']} "
        f"candidates_checked={len(values)} findings={counts['finding']} "
        f"benign_literals={counts['benign_literals']} allowlisted={counts['allowlisted']} "
        f"hash_receipts={counts['hash_receipts']} known_fixture={counts['known_fixture']} "
        f"candidates_hit={counts['candidates_hit']}"
    )
    if counts["finding"]:
        print(f"RESULT: FINDINGS PRESENT ({counts['finding']}) — DO NOT PUBLISH")
        return 1
    if counts["known_fixture"]:
        print(f"RESULT: CLEAN ({counts['known_fixture']} known_fixture listed above — values pragma-declared at HEAD)")
        return 0
    print("RESULT: CLEAN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
