import type { IntegrationStepId, IntegrationActionId } from "../types.js";
import type { IntegrationCatalogStep, IntegrationRunbookDefinition } from "./types.js";

export const integrationCatalogSteps: IntegrationCatalogStep[] = [
  {
    id: "ensure_mac_allowlist",
    title: "Ensure Mac allowlist",
    mutating: true,
    description: "Adds required apps to the mac control allowlist.",
  },
  {
    id: "open_mac_app",
    title: "Open Mac app",
    mutating: true,
    description: "Opens an allowed app with optional URL.",
  },
  {
    id: "focus_mac_app",
    title: "Focus Mac app",
    mutating: true,
    description: "Brings an allowed app to foreground.",
  },
  {
    id: "set_provider_mode",
    title: "Set provider mode",
    mutating: true,
    description: "Switches routing mode between openrouter, claude_subscription, or hybrid.",
  },
  {
    id: "check_claude_session",
    title: "Check Claude session",
    mutating: false,
    description: "Checks local Claude CLI subscription session detection.",
  },
  {
    id: "set_livekit_config",
    title: "Set LiveKit config",
    mutating: true,
    description: "Applies LiveKit configuration values.",
  },
  {
    id: "start_watch_session",
    title: "Start watch session",
    mutating: true,
    description: "Starts a watch session for a supported source.",
  },
  {
    id: "stop_watch_session",
    title: "Stop watch session",
    mutating: true,
    description: "Stops a watch session by id.",
  },
  {
    id: "mint_livekit_viewer_token",
    title: "Mint viewer token",
    mutating: false,
    description: "Mints LiveKit observer token for watch/session context.",
  },
  {
    id: "refresh_integrations_status",
    title: "Refresh integrations status",
    mutating: false,
    description: "Recomputes integration control-plane status snapshot.",
  },
];

export const integrationRunbooks: IntegrationRunbookDefinition[] = [
  {
    id: "prepare_observer_workspace",
    title: "Prepare Observer Workspace",
    description: "Ensure control allowlist and watch prerequisites are ready for observation.",
    steps: [
      {
        id: "ensure_mac_allowlist",
        args: {
          apps: ["antigravity", "terminal", "chrome"],
        },
      },
      {
        id: "check_claude_session",
        args: {},
      },
      {
        id: "refresh_integrations_status",
        args: {},
      },
    ],
  },
  {
    id: "launch_watch_surface",
    title: "Launch Watch Surface",
    description: "Open chrome surface and start embedded watch stream.",
    steps: [
      {
        id: "open_mac_app",
        args: {
          appId: "chrome",
          url: "https://x.com/home",
        },
      },
      {
        id: "start_watch_session",
        args: {
          sourceId: "embedded-browser",
          fps: 2,
        },
      },
      {
        id: "refresh_integrations_status",
        args: {},
      },
    ],
  },
  {
    id: "repair_provider_route",
    title: "Repair Provider Route",
    description: "Set hybrid route and validate Claude session readiness.",
    steps: [
      {
        id: "set_provider_mode",
        args: {
          mode: "hybrid",
        },
      },
      {
        id: "check_claude_session",
        args: {},
      },
      {
        id: "refresh_integrations_status",
        args: {},
      },
    ],
  },
  {
    id: "recover_livekit_bridge",
    title: "Recover LiveKit Bridge",
    description: "Ensure LiveKit config is enabled for frames and ready for control-room bridge.",
    steps: [
      {
        id: "set_livekit_config",
        args: {
          enabled: true,
          streamMode: "events_and_frames",
        },
      },
      {
        id: "mint_livekit_viewer_token",
        args: {
          sourceId: "embedded-browser",
        },
      },
      {
        id: "refresh_integrations_status",
        args: {},
      },
    ],
  },
];

const stepIdSet = new Set<IntegrationStepId>(integrationCatalogSteps.map((step) => step.id));
const runbookMap = new Map<IntegrationActionId, IntegrationRunbookDefinition>(
  integrationRunbooks.map((item) => [item.id, item]),
);

export const isIntegrationStepId = (value: string): value is IntegrationStepId => {
  return stepIdSet.has(value as IntegrationStepId);
};

export const getIntegrationRunbook = (id: string): IntegrationRunbookDefinition | null => {
  return runbookMap.get(id as IntegrationActionId) || null;
};
