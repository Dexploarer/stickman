#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SMOKE_PORT="${SMOKE_PORT:-8790}"
SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:${SMOKE_PORT}}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-30}"
SMOKE_LAST_RESP="${SMOKE_LAST_RESP:-/tmp/mss_smoke_last_resp.json}"
SMOKE_LOG_FILE="${SMOKE_LOG_FILE:-/tmp/mss-smoke-dev.log}"

PASS=0
FAIL=0
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

req() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected="$4"
  local body="${5-}"
  local got

  if [ -n "$body" ]; then
    got=$(curl -s -o "$SMOKE_LAST_RESP" -w "%{http_code}" -X "$method" "${SMOKE_BASE_URL}${path}" -H "Content-Type: application/json" -d "$body")
  else
    got=$(curl -s -o "$SMOKE_LAST_RESP" -w "%{http_code}" -X "$method" "${SMOKE_BASE_URL}${path}")
  fi

  if [ "$got" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo "PASS $name [$got]"
  else
    FAIL=$((FAIL + 1))
    local snippet
    snippet=$(head -c 260 "$SMOKE_LAST_RESP" | tr '\n' ' ')
    echo "FAIL $name [got=$got expected=$expected] $snippet"
  fi
}

wait_for_health() {
  local max_attempts=$((SMOKE_TIMEOUT_SECONDS * 2))
  local code="000"
  local attempt=0
  while [ "$attempt" -lt "$max_attempts" ]; do
    code=$(curl -s -o /tmp/mss_smoke_health.json -w "%{http_code}" "${SMOKE_BASE_URL}/api/health" || true)
    if [ "$code" = "200" ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  return 1
}

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${SMOKE_PORT} already in use; assuming external server mode."
else
  PORT="$SMOKE_PORT" bun run dev >"$SMOKE_LOG_FILE" 2>&1 &
  SERVER_PID="$!"
fi

if ! wait_for_health; then
  echo "Smoke failed: server did not become healthy at ${SMOKE_BASE_URL}/api/health within ${SMOKE_TIMEOUT_SECONDS}s"
  if [ -f "$SMOKE_LOG_FILE" ]; then
    echo "--- server log tail ---"
    tail -n 160 "$SMOKE_LOG_FILE"
  fi
  exit 1
fi

req health GET /api/health 200
req providers_status GET /api/providers/status 200
req integrations_status GET /api/integrations/status 200
req providers_mode_invalid POST /api/providers/mode 400 '{"mode":"invalid"}'
req providers_mode_hybrid POST /api/providers/mode 200 '{"mode":"hybrid"}'
req cowork_state_initial GET /api/cowork/state 200
req cowork_missions GET /api/cowork/missions 200
req claude_login_start POST /api/claude/login/start 200 '{}'
req claude_login_status GET /api/claude/login/status 200
req extensions_list GET /api/extensions 200
req x_disable POST /api/extensions/x-social/disable 200
req x_post_blocked POST /api/x/post 423 '{"text":"smoke test"}'
req x_enable POST /api/extensions/x-social/enable 200
req autonomy_get GET /api/agent/autonomy 200
req autonomy_set POST /api/agent/autonomy 200 '{"enabled":true}'
req approvals_get GET /api/agent/approvals 200
req skills_list GET /api/skills 200
req skill_disable_terminal_open POST /api/skills/terminal.open/disable 200
req skill_run_blocked POST /api/skills/run 423 '{"skillId":"terminal.open"}'
req create_task_disabled_skill POST /api/agent/tasks 200 '{"prompt":"open terminal","skillId":"terminal.open"}'
req cowork_quick_action POST /api/cowork/quick-action 200 '{"action":"open_terminal"}'
req cowork_mission_run POST /api/cowork/missions/social_signal_sweep/run 200 '{"query":"AI agent workspace"}'
req task_chain_create POST /api/agent/tasks/chain 200 '{"tasks":[{"prompt":"Open terminal","skillId":"terminal.open"},{"prompt":"Review repo","skillId":"codex.run_task","args":{"prompt":"Review repo"}}]}'

TASK_ID=$(SMOKE_LAST_RESP="$SMOKE_LAST_RESP" node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.env.SMOKE_LAST_RESP || "/tmp/mss_smoke_last_resp.json","utf8")); const id=x.task?.id || (Array.isArray(x.tasks) ? x.tasks[0]?.id : ""); process.stdout.write(id || "")')
if [ -n "$TASK_ID" ]; then
  sleep 0.3
  req task_detail GET "/api/agent/tasks/${TASK_ID}" 200
  req task_logs GET "/api/agent/tasks/${TASK_ID}/logs?limit=25" 200
  req task_retry POST "/api/agent/tasks/${TASK_ID}/retry" 200
  req task_cancel POST "/api/agent/tasks/${TASK_ID}/cancel" 200
else
  echo "FAIL task_id_parse [missing task id]"
  FAIL=$((FAIL + 1))
fi

req skill_enable_terminal_open POST /api/skills/terminal.open/enable 200
req tasks_list GET /api/agent/tasks 200
req cowork_state_after_tasks GET /api/cowork/state 200
req mac_apps GET /api/mac/apps 200
req mac_policy_get GET /api/mac/policy 200
req mac_open_denied POST /api/mac/apps/open 403 '{"appId":"unknown"}'
req mac_focus_denied POST /api/mac/apps/focus 403 '{"appId":"unknown"}'
req watch_sources GET /api/watch/sources 200
req watch_frame_latest GET /api/watch/frame/latest 200
req livekit_status GET /api/livekit/status 200
req livekit_token_invalid_source POST /api/livekit/token 400 '{"sourceId":"invalid-source"}'
req livekit_config_invalid_prefix POST /api/livekit/config 400 '{"roomPrefix":"invalid prefix!"}'
req livekit_config POST /api/livekit/config 200 '{"enabled":false,"streamMode":"events_only","roomPrefix":"milady-cowork"}'
req watch_start_invalid POST /api/watch/start 400 '{"sourceId":"invalid-source"}'
req watch_start_valid POST /api/watch/start 200 '{"sourceId":"embedded-browser","fps":2}'

WATCH_ID=$(SMOKE_LAST_RESP="$SMOKE_LAST_RESP" node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.env.SMOKE_LAST_RESP || "/tmp/mss_smoke_last_resp.json","utf8")); process.stdout.write(x.session?.id || "")')
if [ -n "$WATCH_ID" ]; then
  req watch_frame_invalid_source POST /api/watch/frame 400 '{"sourceId":"invalid-source","frame":"data:image/png;base64,AAAA"}'
  req watch_stop POST /api/watch/stop 200 "{\"sessionId\":\"${WATCH_ID}\"}"
else
  echo "FAIL watch_id_parse [missing session id]"
  FAIL=$((FAIL + 1))
fi

req live_ws_upgrade GET /api/live/ws 426
req code_status GET /api/code/status 200

echo "SMOKE_SUMMARY pass=${PASS} fail=${FAIL}"
if [ "$FAIL" -ne 0 ]; then
  if [ -f "$SMOKE_LOG_FILE" ]; then
    echo "--- server log tail ---"
    tail -n 200 "$SMOKE_LOG_FILE"
  fi
  exit 1
fi
