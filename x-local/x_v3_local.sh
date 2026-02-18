#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $(basename "$0") <endpoint> [args...]" >&2
  echo "endpoints: user_login_v3 get_my_x_account_detail_v3 send_tweet_v3 like_tweet_v3 retweet_v3 update_profile_v3" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PY="$SCRIPT_DIR/../.venv/bin/python3"
SETUP_SH="$SCRIPT_DIR/setup_env.sh"

if [[ ! -x "$VENV_PY" ]]; then
  if [[ -x "$SETUP_SH" ]]; then
    echo "x-local runtime not initialized. Running setup_env.sh..." >&2
    "$SETUP_SH" >&2
  fi
fi

if [[ -x "$VENV_PY" ]]; then
  "$VENV_PY" "$SCRIPT_DIR/x_v3_local.py" "$@"
else
  "$SCRIPT_DIR/x_v3_local.py" "$@"
fi
