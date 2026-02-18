#!/usr/bin/env bash
set -euo pipefail

WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKDIR"

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

echo "Installing Node dependencies from bun.lock ..."
bun install --frozen-lockfile

echo "Preparing environment file..."
if [ -f .env.example ] && [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example"
elif [ -f .env ]; then
  echo "  .env already exists, skipping copy"
else
  echo "  Warning: .env.example missing; skipping env initialization"
fi

mkdir -p .state .pordie

if [ ! -f .state/onboarding.json ]; then
  echo "{}" > .state/onboarding.json
fi

if [ ! -f .state/openrouter-models-cache.json ]; then
  echo "{}" > .state/openrouter-models-cache.json
fi

echo "Bootstrapping local X runtime..."
bash x-local/setup_env.sh

if ! command -v claude >/dev/null 2>&1; then
  echo "Warning: Claude CLI not found. Claude subscription mode requires the \`claude\` command."
fi

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  if [ -f ".env" ] && grep -qE '^OPENROUTER_API_KEY=' .env; then
    :
  else
    echo "Warning: OPENROUTER_API_KEY not set. Image/video/embedding/voice features require OpenRouter."
  fi
fi

echo "Environment bootstrap complete."
echo "Recommended checks:"
echo "  bun run verify"
echo "Run app:"
echo "  bun run dev"
