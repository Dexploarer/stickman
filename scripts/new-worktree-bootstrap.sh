#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <branch-name> <worktree-path>" >&2
  echo "Example: $0 feature/autonomy ../milady-social-suite-autonomy" >&2
  exit 1
fi

BRANCH="$1"
WORKTREE_PATH="$2"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "Missing required dependency: git" >&2
  exit 1
fi

if [ -d "$WORKTREE_PATH" ]; then
  echo "Worktree path already exists: $WORKTREE_PATH" >&2
  exit 1
fi

git worktree add "$WORKTREE_PATH" -b "$BRANCH"

echo "Running setup in new worktree..."
cd "$WORKTREE_PATH"
bash scripts/setup-worktree.sh

echo "Done."
echo "Next:"
echo "  cd $WORKTREE_PATH"
echo "  bun run verify"
echo "  bun run dev"
