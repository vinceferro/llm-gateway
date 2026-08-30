#!/usr/bin/env bash
# export-public-mirror.sh — build the public-mirror export from HEAD.
#
# METHOD: `git archive HEAD` unpacked into a fresh export dir, then the
# exclude policy is applied by DELETING from the export. The archive step is
# the leak guard: it can only contain TRACKED files, so untracked/gitignored
# machine-local files (llm-gateway.json with real keys, llm-gateway.json.bak*,
# .kickoff/instance.env, .claude/settings.json, *.log …) can never appear.
#
# EXCLUDE POLICY (encoded — non-controversial only):
#   .kickoff/            private brain — the operator's rule: never published.
#   AGENTS.md CLAUDE.md  @-include .kickoff/* files; once .kickoff/ is stripped
#                        they dangle and break → excluded by the same rule.
#   .claude/ .opencode/ opencode.json lefthook.yml
#                        excluded by operator-ratified default 2026-08-30
#                        (internal orchestration; lefthook.yml dangles without
#                        .kickoff).
#   docs/PUBLISHING.md   excluded 2026-08-30 — the operator's private publish
#                        runbook (references workspace-only secret-file paths);
#                        the public story lives in README/GUARANTEES/bench.
# Everything else tracked REMAINS in the export. Items needing an operator
# blessing are ASK-listed in the inventory below (bless them, or add them to
# EXCLUDES above and re-run).
#
# Output: inventory of REMAINS (grouped public / ASK) + excluded list + file
# count and size. Exit 0. The export dir is LEFT IN PLACE for review — this
# script never pushes, never creates a repo, never touches the network.

set -euo pipefail

EXCLUDES=(.kickoff AGENTS.md CLAUDE.md .claude .opencode opencode.json lefthook.yml docs/PUBLISHING.md)

# Tracked-but-needs-a-decision: kept in the export until the operator blesses
# them (add to EXCLUDES to strip). Currently EMPTY: the four former ASK rows
# (.claude/ .opencode/ opencode.json lefthook.yml) moved to EXCLUDES above —
# excluded by operator-ratified default 2026-08-30 (internal orchestration;
# lefthook.yml dangles without .kickoff), as did docs/PUBLISHING.md. The
# mechanism stays for future judgment-call files.
ASK=()

SRC="$(git rev-parse --show-toplevel)"
HEAD_SHA="$(git -C "$SRC" rev-parse --short HEAD)"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/llm-gateway-public-mirror.XXXXXX")}"

if [[ -e "$OUT" ]]; then
  if [[ -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
    echo "export-public-mirror: refusing non-empty output dir: $OUT" >&2
    exit 2
  fi
else
  mkdir -p "$OUT"
fi

# 1) tracked-only snapshot (no .git, no untracked, no ignored files possible)
git -C "$SRC" archive HEAD | tar -x -C "$OUT"

# 2) apply the exclude policy by deleting from the export
for e in "${EXCLUDES[@]}"; do
  rm -rf "${OUT:?}/$e"
done

# 3) paranoia asserts (the whole point of the export is that these hold)
[[ ! -e "$OUT/.git" ]]            || { echo "FAIL: .git leaked into export" >&2; exit 1; }
[[ ! -e "$OUT/.kickoff" ]]        || { echo "FAIL: .kickoff leaked into export" >&2; exit 1; }
[[ ! -e "$OUT/llm-gateway.json" ]] || { echo "FAIL: gitignored config leaked into export" >&2; exit 1; }
for e in .claude .opencode opencode.json lefthook.yml; do
  # shellcheck disable=SC2312
  [[ ! -e "$OUT/$e" ]] || { echo "FAIL: $e leaked into export (ratified exclude 2026-08-30)" >&2; exit 1; }
done

# 4) inventory of REMAINS, grouped (one-word verdicts per top-level entry)
echo "PUBLIC MIRROR EXPORT — ${SRC##*/} @ ${HEAD_SHA}"
echo "export dir: $OUT"
echo
echo "EXCLUDED (policy):"
for e in "${EXCLUDES[@]}"; do
  echo "  exclude  $e"
done
git -C "$SRC" ls-tree --name-only HEAD | grep -q '^\.github$' \
  || echo "  n/a      .github (not present in this repo)"
echo
echo "REMAINS — public:"
while IFS= read -r entry; do
  skip=no
  for e in "${EXCLUDES[@]}"; do
    [[ "$entry" == "$e" ]] && { skip=yes; break; }
  done
  ask=no
  for a in "${ASK[@]}"; do
    [[ "$a" == "$entry:"* ]] && { ask=yes; break; }
  done
  [[ "$skip" == no && "$ask" == no ]] && echo "  public   $entry"
done < <(git -C "$SRC" ls-tree --name-only HEAD)
echo
echo "REMAINS — ASK (operator must bless or add to EXCLUDES — see the EXCLUDE POLICY header):"
if [[ "${#ASK[@]}" -eq 0 ]]; then
  echo "  (none — former ASK rows .claude/ .opencode/ opencode.json lefthook.yml and"
  echo "   docs/PUBLISHING.md are now excluded by operator-ratified defaults; see header)"
else
  for a in "${ASK[@]}"; do
    echo "  ASK      ${a%%:*}  (${a#*:})"
  done
fi
echo
files="$(find "$OUT" -type f | wc -l)"
bytes="$(find "$OUT" -type f -printf '%s\n' | awk '{s+=$1} END {printf "%.0f", s}')"
printf 'export: %s files, %s bytes (%s KiB)\n' "$files" "$bytes" "$(( bytes / 1024 ))"
echo "next: review the ASK list, then run the operator runbook (secrets audit → publish → verify)."
