#!/usr/bin/env bash
set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKDIR"

warn() {
  echo "Warning: $*" >&2
}

info() {
  echo "$*"
}

if ! command -v bun >/dev/null 2>&1; then
  echo "Missing required dependency: bun. Install Bun and retry." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing required dependency: python3. Install Python 3 and retry." >&2
  exit 1
fi

if [ ! -f "x-local/setup_env.sh" ]; then
  echo "Missing required runtime script: x-local/setup_env.sh" >&2
  exit 1
fi

info "Installing Node dependencies from bun.lock ..."
bun install --frozen-lockfile

info "Preparing environment file..."
if [ -f .env.example ] && [ ! -f .env ]; then
  cp .env.example .env
  info "  Created .env from .env.example"
elif [ -f .env ]; then
  info "  .env already exists, skipping copy"
else
  warn ".env.example missing; skipping env initialization"
fi

mkdir -p .state .pordie

if [ ! -f .state/onboarding.json ]; then
  echo "{}" > .state/onboarding.json
fi

if [ ! -f .state/openrouter-models-cache.json ]; then
  echo "{}" > .state/openrouter-models-cache.json
fi

if [ ! -f .pordie/config.json ]; then
  echo "{}" > .pordie/config.json
fi

if [ ! -f .pordie/env.sh ]; then
  cat > .pordie/env.sh <<'EOF'
#!/usr/bin/env bash
# Local project-scoped overrides for Prompt or Die.
# export EXAMPLE_KEY="value"
EOF
  chmod +x .pordie/env.sh
fi

info "Bootstrapping local X runtime..."
bash x-local/setup_env.sh

CLAUDE_CLI_COMMAND="${CLAUDE_CLI_COMMAND:-claude -p}"
CLAUDE_CLI_BIN="${CLAUDE_CLI_COMMAND%% *}"
if ! command -v "$CLAUDE_CLI_BIN" >/dev/null 2>&1; then
  warn "Claude CLI command not found for CLAUDE_CLI_COMMAND='$CLAUDE_CLI_COMMAND'. Install Claude CLI or set CLAUDE_CLI_COMMAND to your local binary."
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  if [ -f ".env" ] && grep -qE '^OPENROUTER_API_KEY=[^[:space:]]+' .env; then
    :
  else
    warn "OPENROUTER_API_KEY not set. Image/video/embedding/voice features require OpenRouter."
  fi
fi

if ! command -v codex >/dev/null 2>&1; then
  warn "Codex CLI not found in PATH. Coding-task skills can still run with fallback paths if configured."
fi

if open -Ra "Antigravity" >/dev/null 2>&1; then
  ANTIGRAVITY_STATUS="found"
else
  ANTIGRAVITY_STATUS="missing"
  warn "Antigravity app not found. antigravity.open skill will fail until the app is installed."
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  CHROME_STATUS="found"
else
  CHROME_STATUS="missing"
  warn "Google Chrome.app not found. browser.external.chrome.open will not be available."
fi

info
info "Local tool status:"
printf "  %-24s %s\n" "Bun" "$(command -v bun)"
printf "  %-24s %s\n" "Python3" "$(command -v python3)"
printf "  %-24s %s\n" "Claude CLI command" "$CLAUDE_CLI_COMMAND"
printf "  %-24s %s\n" "Codex CLI" "$(command -v codex 2>/dev/null || echo missing)"
printf "  %-24s %s\n" "Antigravity app" "$ANTIGRAVITY_STATUS"
printf "  %-24s %s\n" "Google Chrome app" "$CHROME_STATUS"

info
info "Environment bootstrap complete."
info "Recommended checks:"
info "  bun run verify"
info "Run app:"
info "  bun run dev"
