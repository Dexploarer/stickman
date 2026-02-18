# Prompt or Die Social Suite

Local-first social automation stack with onboarding, OpenRouter model orchestration, workflow automation, and both Web + TUI surfaces.

## Location

`/Users/home/milady-social-suite`

## Highlights

- Local X automation runner (cookie/session based)
- Provider routing across:
  - Claude subscription session via local CLI bridge (`claude login`)
  - OpenRouter API mode
  - hybrid fallback mode
- Extension registry (starting with `x-social`) with backend enforcement + approval queue
- Mixed autonomy controls (auto-read/signal analysis, approval-gated write/auth actions)
- Agentic cowork UI with Milady-style 3-lane layout (conversations, task chat, autonomy stream)
- Embedded live observer iframe (`/live.html`) backed by realtime SSE events (`/api/live/events`)
- Native coding-agent workflow with guarded workspace command execution (`code-workspace` extension)
- Skill registry and task runtime (`/api/skills`, `/api/agent/tasks`) with guarded approvals
- Mac control bridge for Antigravity, Terminal, and Chrome with allowlist policy (`/api/mac/apps`, `/api/mac/policy`)
- Watch-along screenshare channel with websocket stream (`/api/live/ws`) and watch sessions (`/api/watch/*`)
- CLI bridges honor local overrides: `POD_CODEX_CLI_PATH`, `CODEX_CLI_COMMAND`, `CLAUDE_CLI_COMMAND`
- Onboarding for:
  - OpenRouter key test
  - provider mode selection + Claude session checks
  - model cache + model selection (text/image/video/embedding/voice)
  - optional defaults/fallbacks
  - optional local key import from `process.env`, `~/.config`, `~/.claude`, and shell profiles (explicit opt-in)
  - optional X credential/login test
  - persona/style source and derivation options (profile + tweets/reposts/media-aware extraction with real post examples)
- Optional `.pordie` config export:
  - default scope is global home config: `~/.pordie`
  - optional project override scope: `./.pordie`
  - files: `config.json`, `.env`, `env.sh`
  - optional sync into project `.env`
- Native X operations via local browser profile/session with optional visibility, compatibility mode, and notifications
- Heartbeat agent loop (default every 20 minutes) that fetches timeline + notifications, builds context, and can auto-act via planner
- Full dashboard + workflow runner
- Full TUI + onboarding wizard + workflow builder

## Setup

```bash
cd "/Users/home/milady-social-suite"
bun run setup
bun run verify
```

For each additional git worktree, run the same command after creating and entering the new worktree:

```bash
cd /path/to/other/worktree
bun run setup
bun run verify
```

Optional helper to create + bootstrap a new worktree in one command:

```bash
cd "/Users/home/milady-social-suite"
scripts/new-worktree-bootstrap.sh feature/branch-name /path/to/new/worktree
```

## Worktree Setup Troubleshooting

- `bun: command not found`: install Bun and re-run `bun run setup`.
- `python3: command not found`: install Python 3 and re-run `bun run setup`.
- `x-local/setup_env.sh missing`: ensure the repository checkout includes `x-local/`.
- `claude command not found`: install Claude CLI to use subscription mode (`claude login`), or set `CLAUDE_CLI_COMMAND` if your binary path/syntax differs.
- `codex command not found`: install Codex CLI or configure the coding executor override in your local env.
- `Antigravity app not found`: install Antigravity if you want `antigravity.open` skills enabled.
- `Google Chrome.app not found`: install Chrome if you want external browser handoff enabled.
- `OPENROUTER_API_KEY not set`: text fallback may still work in Claude mode, but image/video/embedding/voice require OpenRouter.
- `LIVEKIT_WS_URL set without LIVEKIT_API_SECRET`: LiveKit control-room bridge will remain disabled.
- `X_NOTIFY_WEBHOOK not set`: outbound integration webhook fanout is optional and currently disabled.

Setup now also guarantees per-worktree local state scaffolding:

- `./.state/onboarding.json`
- `./.state/openrouter-models-cache.json`
- `./.state/integration-bridge.json`
- `./.pordie/config.json`
- `./.pordie/env.sh`

## Environment Notes

- `PORDIE_SCOPE=global|project` (optional) forces export scope regardless of onboarding value
- `X_NOTIFY` defaults to enabled when unset
- Local secret import is explicit one-shot permission only (`allowLocalSecretsRead=true`)
- X operations may still require interactive challenge/2FA/human verification depending on account state

## Run

```bash
# API + Web UI
bun run dev
```

```bash
# TUI
bun run tui
```

Web UI:

`http://localhost:8787`

## Testing and Verification

```bash
# Type-check + tests + API smoke pass
bun run verify
```

```bash
# Unit/integration tests only
bun test
```

```bash
# Endpoint smoke pass only
bun run smoke:api
```

## Contributor Trust Scoring

This repo includes a game-theory-resistant contributor trust system for agent contributors:

- Engine: `/Users/home/milady-social-suite/.github/trust-scoring.cjs`
- State store: `/Users/home/milady-social-suite/.github/contributor-trust.json`
- CI snapshot workflow: `/Users/home/milady-social-suite/.github/workflows/contributor-trust.yml`

Run locally:

```bash
# Score all contributors in the state file
node .github/trust-scoring.cjs summary --state-file .github/contributor-trust.json
```

```bash
# Score one contributor
node .github/trust-scoring.cjs score --contributor agent-alice --state-file .github/contributor-trust.json
```

```bash
# Record an event (dry run: no file write)
node .github/trust-scoring.cjs record --contributor agent-alice --type approve --lines 220 --labels bugfix,core --pr 42 --state-file .github/contributor-trust.json
```

```bash
# Record an event and persist it to state
node .github/trust-scoring.cjs record --contributor agent-alice --type approve --lines 220 --labels bugfix,core --pr 42 --state-file .github/contributor-trust.json --write
```

Environment knobs for smoke:

- `SMOKE_PORT` (default `8790`)
- `SMOKE_BASE_URL` (optional; if set to an existing server, no new server is started)
- `SMOKE_TIMEOUT_SECONDS` (default `30`)

Optional LiveKit env (for remote cowork transport):

- `LIVEKIT_WS_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_ROOM_PREFIX`
- `LIVEKIT_STREAM_MODE` (`events_only` or `events_and_frames`)

LiveKit enable policy:

- `POST /api/livekit/config` rejects `enabled=true` unless `wsUrl`, `apiKey`, and `LIVEKIT_API_SECRET` are all configured.

## Native Apple App (Swift)

```bash
cd "/Users/home/milady-social-suite/native/apple"
swift run
```

Install as a normal clickable macOS app on Desktop:

```bash
cd "/Users/home/milady-social-suite/native/apple"
bash build_app.sh
```

This creates and launches:

`~/Desktop/Prompt or Die Social Suite.app`

## Main API Endpoints

- `GET /api/health`
- `GET /api/providers/status`
- `POST /api/providers/mode`
- `POST /api/claude/login/start`
- `GET /api/claude/login/status`
- `GET /api/live/snapshot`
- `GET /api/live/events`
- `GET /api/live/ws` (websocket upgrade endpoint)
- `POST /api/cowork/dispatch`
- `GET /api/cowork/state`
- `POST /api/cowork/quick-action`
- `GET /api/cowork/missions`
- `POST /api/cowork/missions/:id/run`
- `GET /api/extensions`
- `POST /api/extensions/:id/enable`
- `POST /api/extensions/:id/disable`
- `GET /api/skills`
- `POST /api/skills/:id/enable`
- `POST /api/skills/:id/disable`
- `POST /api/skills/run`
- `GET /api/skills/approvals`
- `POST /api/skills/approvals/:id/approve`
- `POST /api/skills/approvals/:id/reject`
- `POST /api/agent/tasks`
- `POST /api/agent/tasks/chain`
- `GET /api/agent/tasks`
- `GET /api/agent/tasks/:id`
- `GET /api/agent/tasks/:id/logs`
- `POST /api/agent/tasks/:id/cancel`
- `POST /api/agent/tasks/:id/retry`
- `GET /api/mac/apps`
- `POST /api/mac/apps/open`
- `POST /api/mac/apps/focus`
- `GET /api/mac/policy`
- `POST /api/mac/policy`
- `GET /api/watch/sources`
- `POST /api/watch/start`
- `POST /api/watch/stop`
- `GET /api/watch/frame/latest`
- `POST /api/watch/frame`
- `GET /api/livekit/status`
- `POST /api/livekit/config`
- `POST /api/livekit/token`
- `POST /api/livekit/token/control`
- `GET /api/integrations/status`
- `GET /api/integrations/actions/catalog`
- `GET /api/integrations/actions/history`
- `POST /api/integrations/actions`
- `GET /api/integrations/subscriptions`
- `POST /api/integrations/subscriptions`
- `POST /api/integrations/subscriptions/:id/enable`
- `POST /api/integrations/subscriptions/:id/disable`
- `POST /api/integrations/subscriptions/:id/test`
- `DELETE /api/integrations/subscriptions/:id`
- `GET /api/integrations/bridge/status`
- `GET /api/code/status`
- `POST /api/code/plan`
- `POST /api/code/exec`
- `GET /api/code/approvals`
- `POST /api/code/approvals/:id/approve`
- `POST /api/code/approvals/:id/reject`
- `GET /api/agent/autonomy`
- `POST /api/agent/autonomy`
- `GET /api/agent/approvals`
- `POST /api/agent/approvals/:id/approve`
- `POST /api/agent/approvals/:id/reject`
- `GET /api/onboarding/state`
- `POST /api/onboarding/test-openrouter-key`
- `POST /api/onboarding/refresh-model-cache`
- `POST /api/onboarding/save`
- `POST /api/onboarding/complete`
- `POST /api/onboarding/export-env`

## Integration Bridge Delivery

- Bridge fanout publishes `integration_*` events to registered webhooks and LiveKit control room when configured.
- Signed webhook header: `x-stickman-signature: sha256=<hex>` computed from raw JSON body with subscriber secret.
- Delivery metadata headers:
- `x-stickman-event-id`
- `x-stickman-event-type`
- `x-stickman-attempt`
- Retry schedule: `1s`, `3s`, `9s` (max 3 attempts total).
- `POST /api/onboarding/import-local-secrets`
- `POST /api/onboarding/test-x-login`
- `POST /api/persona/derive`
- `GET /api/heartbeat/status`
- `POST /api/heartbeat/run-now`
- `GET /api/x/catalog`
- `POST /api/x/run`
- `POST /api/x/workflow`
- `POST /api/x/login`
- `POST /api/x/post`
- `POST /api/ai/chat`
- `POST /api/ai/x-algorithm-intel`
- `POST /api/ai/automation-plan`
- `POST /api/ai/image`
- `POST /api/ai/video`
- `POST /api/ai/embedding`
- `POST /api/ai/voice`

## OpenRouter Video Support Notes

- The suite now groups and exposes OpenRouter `video`-capable models in onboarding and dashboard selectors.
- `/api/ai/video` is wired for multimodal video input analysis (video URL or data URL + prompt).
- OpenRouter model availability is live-catalog based; output-video generation models may vary by date and account access.

## X Algorithm Open-Source Intel

- Dashboard now includes `X Algorithm OS Lab` for draft scoring + optimization.
- `/api/ai/x-algorithm-intel` combines:
  - account artifact extraction (tweets/reposts/media/follower samples),
  - open-source heavy-ranker style weighted action scoring,
  - candidate query suggestions (trends + source-specific),
  - optimized drafts that can be pushed directly into Tweet Composer.
- Suggested query workflows can auto-run directly from the algorithm panel.

## Heartbeat Agent Loop

- Scheduler defaults to every `20` minutes (`HEARTBEAT_INTERVAL_MINUTES`).
- Each cycle pulls:
  - `home_timeline`
  - `notifications_list`
- Then it builds context, summarizes signal, and (if `HEARTBEAT_AUTO_ACT=true`) runs planner-driven actions.

## Loading exported env in terminal

After exporting Prompt or Die config, run:

```bash
source ~/.pordie/env.sh
```

If using project scope override:

```bash
cd "/Users/home/Desktop/shaws projects/milady-social-suite"
source .pordie/env.sh
```
