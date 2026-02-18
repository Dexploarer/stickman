import type { IntegrationBridgeEvent } from "./types.js";

export interface LivekitControlConfig {
  enabled: boolean;
  configured: boolean;
  wsUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  roomPrefix: string;
}

const toLivekitApiUrl = (wsUrl: string): string => {
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice("wss://".length)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice("ws://".length)}`;
  }
  if (wsUrl.startsWith("https://") || wsUrl.startsWith("http://")) {
    return wsUrl;
  }
  return `https://${wsUrl}`;
};

export class LivekitControlPublisher {
  private resolveConfig: () => LivekitControlConfig;
  private client: unknown = null;
  private clientKey = "";
  private lastError: string | undefined;

  constructor(resolveConfig: () => LivekitControlConfig) {
    this.resolveConfig = resolveConfig;
  }

  private async ensureClient(config: LivekitControlConfig): Promise<unknown> {
    const key = `${config.wsUrl || ""}|${config.apiKey || ""}|${config.apiSecret || ""}`;
    if (this.client && this.clientKey === key) {
      return this.client;
    }
    const mod = (await import("livekit-server-sdk")) as unknown as {
      RoomServiceClient?: new (host: string, apiKey: string, apiSecret: string) => unknown;
    };
    if (!mod.RoomServiceClient || !config.wsUrl || !config.apiKey || !config.apiSecret) {
      this.client = null;
      this.clientKey = "";
      return null;
    }
    this.client = new mod.RoomServiceClient(toLivekitApiUrl(config.wsUrl), config.apiKey, config.apiSecret);
    this.clientKey = key;
    return this.client;
  }

  async publish(event: IntegrationBridgeEvent): Promise<void> {
    const config = this.resolveConfig();
    if (!config.enabled || !config.configured || !config.wsUrl || !config.apiKey || !config.apiSecret) {
      return;
    }
    try {
      const client = await this.ensureClient(config);
      if (!client) {
        return;
      }
      const room = `${config.roomPrefix || "milady-cowork"}-control`;
      const payload = Buffer.from(JSON.stringify(event));
      const roomService = client as {
        sendData?: (...args: unknown[]) => Promise<unknown>;
      };
      if (typeof roomService.sendData === "function") {
        await roomService.sendData(room, payload, undefined, undefined, "integration_control");
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  getStatus() {
    const config = this.resolveConfig();
    const room = `${config.roomPrefix || "milady-cowork"}-control`;
    return {
      enabled: config.enabled,
      configured: config.configured,
      room,
      publisherReady: Boolean(config.enabled && config.configured && config.wsUrl && config.apiKey && config.apiSecret),
      lastPublishError: this.lastError,
    };
  }
}
