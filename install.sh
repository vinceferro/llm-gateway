#!/usr/bin/env bash
#
# llm-gateway installer — fresh-machine path, safe to run via:
#   curl -fsSL <repo-raw-url>/install.sh | bash
#
# What it does:
#   1. checks bash / node >= 22.6 / curl-or-wget / npm (clear fix hints)
#   2. installs the app to ~/.llm-gateway/app  (copies the local checkout you
#      ran it from, or clones --depth 1 from $LLM_GATEWAY_REPO_URL)
#   3. generates ~/.llm-gateway/llm-gateway.json via src/bootstrap.ts —
#      admin key + one gateway key + local-runtime detection. Never overwrites.
#   4. writes a systemd user unit + enables it (Linux + systemd only)
#   5. prints a finish panel with the key and exact next commands
#
# Env overrides: LLM_GATEWAY_HOME, LLM_GATEWAY_APP_DIR, LLM_GATEWAY_REPO_URL

set -euo pipefail

LG_HOME="${LLM_GATEWAY_HOME:-$HOME/.llm-gateway}"
APP_DIR="${LLM_GATEWAY_APP_DIR:-$LG_HOME/app}"
REPO_URL="${LLM_GATEWAY_REPO_URL:-https://github.com/vinceferro/llm-gateway.git}"
CONFIG_PATH="$LG_HOME/llm-gateway.json"
ENV_FILE="$LG_HOME/env"

info() { printf '%s\n' "[install] $*"; }
die()  { printf '%s\n' "[install] ERROR: $*" >&2; exit 1; }

# --- pure helpers (sourcable for tests with INSTALL_SH_LIB=1) -----------------

# node_version_gte MAJOR MINOR [version] -> 0 when the (given or installed) node >= MAJOR.MINOR
node_version_gte() {
  local v="${3:-}"
  if [[ -z "$v" ]]; then v="$(node --version 2>/dev/null)" || return 1; fi
  [[ "$v" =~ ^v([0-9]+)\.([0-9]+)(\.([0-9]+))?$ ]] || return 1
  local major minor
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  if (( major > $1 )); then return 0; fi
  (( major == $1 && minor >= $2 ))
}

# running from a repo checkout (vs piped stdin / random dir)?
in_repo_checkout() {
  [[ -f "./install.sh" && -f "./package.json" && -f "./src/main.ts" ]]
}

# --- 1. preflight -------------------------------------------------------------

check_prereqs() {
  command -v node >/dev/null 2>&1 \
    || die "node is not installed. Install Node.js 22.6+ (https://nodejs.org — or 'sudo apt install nodejs npm' / your package manager), then re-run."
  node_version_gte 22 6 \
    || die "node $(node --version 2>/dev/null || echo '?') is too old — llm-gateway needs >= v22.6 (native TypeScript, no build step). Upgrade node and re-run."
  command -v npm >/dev/null 2>&1 \
    || die "npm is not installed (it ships with node). Install Node.js 22.6+ and re-run."
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "neither curl nor wget is available (needed to fetch the source). Install curl ('sudo apt install curl') and re-run."
  fi
}

# --- 2. app tree --------------------------------------------------------------

install_tree() {
  mkdir -p "$LG_HOME"
  if [[ -d "$APP_DIR" ]]; then
    info "app tree already exists at $APP_DIR — keeping it (delete it to force a fresh install)"
    return 0
  fi

  if in_repo_checkout; then
    info "installing from this checkout: $PWD -> $APP_DIR"
    mkdir -p "$APP_DIR"
    tar -C "$PWD" -cf - --exclude='.git' --exclude='node_modules' . | tar -C "$APP_DIR" -xf -
  else
    command -v git >/dev/null 2>&1 \
      || die "git is not installed and this isn't a repo checkout. Install git ('sudo apt install git') or clone the repo and run install.sh from inside it."
    info "cloning $REPO_URL (shallow) -> $APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
  fi

  info "running npm install --omit=dev (llm-gateway has zero runtime deps — this is quick)"
  (cd "$APP_DIR" && npm install --omit=dev --no-fund --no-audit --loglevel=error)
}

# --- 3. config bootstrap ------------------------------------------------------

bootstrap_config() {
  if [[ -f "$CONFIG_PATH" ]]; then
    info "config already exists at $CONFIG_PATH — keeping it untouched (bootstrap never overwrites)"
    return 0
  fi
  info "generating config + probing for local model servers (ollama / llama.cpp / LM Studio)…"
  (cd "$APP_DIR" && node --disable-warning=ExperimentalWarning --experimental-strip-types src/bootstrap.ts --out "$CONFIG_PATH" --detect)
  chmod 600 "$CONFIG_PATH" 2>/dev/null || true
}

# --- 4. provider-key env file (placeholders only — never real keys) -----------

write_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return 0
  fi
  cat > "$ENV_FILE" <<'EOF'
# llm-gateway provider API keys live here as NAME=value exports.
# The systemd unit loads this file automatically; for manual runs, `set -a; source ~/.llm-gateway/env; set +a`.
# Never put provider keys in llm-gateway.json — the config only ever names env vars.
# Example (uncomment + fill in when you fund a provider):
# DEEPSEEK_API_KEY=sk-...
# MOONSHOT_API_KEY=sk-...
EOF
  chmod 600 "$ENV_FILE"
}

# --- 5. systemd user unit -----------------------------------------------------

install_systemd() {
  if [[ "$(uname -s)" != "Linux" ]] || ! command -v systemctl >/dev/null 2>&1; then
    info "systemd not available on this system — skipping the service (start manually with: gateway start)"
    return 0
  fi
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    info "systemd user session not reachable — skipping the service (start manually with: gateway start)"
    return 0
  fi

  local node_bin unit_dir unit_file
  node_bin="$(command -v node)"
  unit_dir="$HOME/.config/systemd/user"
  unit_file="$unit_dir/llm-gateway.service"
  if [[ -f "$unit_file" ]]; then
    info "unit already exists at $unit_file — leaving it untouched (edit it by hand if the app moved)"
    return 0
  fi
  mkdir -p "$unit_dir"
  cat > "$unit_file" <<EOF
[Unit]
Description=llm-gateway (local OpenAI-compatible gateway)
After=network.target

[Service]
ExecStart=$node_bin --disable-warning=ExperimentalWarning --experimental-strip-types $APP_DIR/src/main.ts --config $CONFIG_PATH
EnvironmentFile=-$ENV_FILE
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  if systemctl --user enable --now llm-gateway.service >/dev/null 2>&1; then
    info "service enabled and started: $unit_file"
    info "tip: 'loginctl enable-linger $USER' keeps the gateway running after logout"
  else
    info "wrote $unit_file but couldn't enable it — start manually: systemctl --user start llm-gateway"
  fi
}

# --- 6. `gateway` command on PATH ---------------------------------------------

install_shim() {
  local bin_dir="$HOME/.local/bin"
  LG_SHIM_BIN=""   # reset: finish_panel swaps to the absolute launcher when empty
  mkdir -p "$bin_dir" 2>/dev/null || return 0
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      info "note: $bin_dir is not on your PATH — add it, or call the shim as $APP_DIR/bin/gateway"
      return 0
      ;;
  esac
  ln -sf "$APP_DIR/bin/gateway" "$bin_dir/gateway"
  LG_SHIM_BIN="$bin_dir/gateway"
  info "installed the 'gateway' command -> $bin_dir/gateway"
}

# --- 7. finish panel ----------------------------------------------------------

finish_panel() {
  local key
  key="$(grep -o '"sk-lg-[A-Za-z0-9-]*"' "$CONFIG_PATH" 2>/dev/null | head -1 | tr -d '"' || true)"
  local systemd_line
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active llm-gateway.service >/dev/null 2>&1; then
    systemd_line="running now (systemd user service)"
  else
    systemd_line="not started yet"
  fi

  # Bare `gateway` only exists when the shim landed on PATH; otherwise suggest
  # the absolute launcher so every hint is runnable as printed.
  local gw_cmd="gateway"
  if [[ -z "${LG_SHIM_BIN:-}" ]]; then
    gw_cmd="$APP_DIR/bin/gateway"
  fi

  cat <<EOF

============================================================
  llm-gateway is installed.          status: $systemd_line

  app:      $APP_DIR
  config:   $CONFIG_PATH
  storage:  $LG_HOME          (ledger appears at $LG_HOME/usage.jsonl)

  Your gateway key (also inside $CONFIG_PATH — treat it like a password):
      $key

  START IT
      $gw_cmd start            (or: systemctl --user start llm-gateway)
      $gw_cmd status           check it is answering

  CONNECT A CODING TOOL
      $gw_cmd connect opencode        print the provider block (--write merges it)
      $gw_cmd connect aider           env-var instructions
      $gw_cmd connect claude-code     env-var instructions

  CHECK SPEND
      $gw_cmd report                  month-to-date ledger summary

  The server answers on http://127.0.0.1:8090/v1 (OpenAI-compatible).
  Funded providers later: edit $CONFIG_PATH, keys go in $ENV_FILE.
============================================================
EOF
}

# --- main ---------------------------------------------------------------------

main() {
  check_prereqs
  install_tree
  bootstrap_config
  write_env_file
  install_systemd
  install_shim
  finish_panel
}

# library mode: when sourced with INSTALL_SH_LIB=1, expose every function and
# run nothing (guard sits after all definitions so tests can reach them all).
if [[ -n "${INSTALL_SH_LIB:-}" ]]; then
  return 0 2>/dev/null || true
fi

main "$@"
