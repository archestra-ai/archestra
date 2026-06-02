import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import config from "@/config";
import logger from "@/logging";

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 10_000;
const STATE_FILE_NAME = "instance-analytics.json";
const INSTANCE_STARTED_EVENT = "instance_started";
const INSTANCE_HEARTBEAT_EVENT = "instance_heartbeat";

type Fetch = typeof fetch;

type InstanceAnalyticsState = {
  instanceId: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
};

type InstanceAnalyticsConfig = {
  enabled: boolean;
  posthog: {
    key: string;
    host: string;
  };
  stateDir: string;
};

class InstanceAnalyticsService {
  constructor(
    private readonly options: {
      analyticsConfig?: InstanceAnalyticsConfig;
      appVersion?: string;
      fetch?: Fetch;
      now?: () => Date;
      createInstanceId?: () => string;
    } = {},
  ) {}

  async trackStartup(): Promise<void> {
    const analyticsConfig = this.options.analyticsConfig ?? config.analytics;
    if (!analyticsConfig.enabled || !analyticsConfig.posthog.key) return;

    const now = this.getNow();
    const state = await this.readState(analyticsConfig.stateDir);

    if (!state.startedAt) {
      await this.capture({
        analyticsConfig,
        event: INSTANCE_STARTED_EVENT,
        distinctId: state.instanceId,
      });
      state.startedAt = now.toISOString();
      await this.writeState(analyticsConfig.stateDir, state);
    }

    if (shouldSendHeartbeat(state.lastHeartbeatAt, now)) {
      await this.capture({
        analyticsConfig,
        event: INSTANCE_HEARTBEAT_EVENT,
        distinctId: state.instanceId,
      });
      state.lastHeartbeatAt = now.toISOString();
      await this.writeState(analyticsConfig.stateDir, state);
    }
  }

  private async capture({
    analyticsConfig,
    event,
    distinctId,
  }: {
    analyticsConfig: InstanceAnalyticsConfig;
    event: string;
    distinctId: string;
  }): Promise<void> {
    const response = await this.getFetch()(getCaptureUrl(analyticsConfig), {
      method: "POST",
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: analyticsConfig.posthog.key,
        event,
        distinct_id: distinctId,
        properties: {
          app_version: this.options.appVersion ?? config.api.version,
          source: "backend",
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `PostHog capture failed with status ${response.status} ${response.statusText}`,
      );
    }
  }

  private async readState(stateDir: string): Promise<InstanceAnalyticsState> {
    try {
      const contents = await readFile(getStateFilePath(stateDir), "utf-8");
      const state = JSON.parse(contents) as Partial<InstanceAnalyticsState>;
      if (typeof state.instanceId === "string" && state.instanceId.length > 0) {
        return {
          instanceId: state.instanceId,
          startedAt:
            typeof state.startedAt === "string" ? state.startedAt : undefined,
          lastHeartbeatAt:
            typeof state.lastHeartbeatAt === "string"
              ? state.lastHeartbeatAt
              : undefined,
        };
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        logger.warn({ err: error }, "Failed to read instance analytics state");
      }
    }

    return {
      instanceId: this.createInstanceId(),
    };
  }

  private async writeState(
    stateDir: string,
    state: InstanceAnalyticsState,
  ): Promise<void> {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      getStateFilePath(stateDir),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf-8",
    );
  }

  private getFetch(): Fetch {
    return this.options.fetch ?? fetch;
  }

  private getNow(): Date {
    return this.options.now?.() ?? new Date();
  }

  private createInstanceId(): string {
    return this.options.createInstanceId?.() ?? randomUUID();
  }
}

export const instanceAnalyticsService = new InstanceAnalyticsService();

function shouldSendHeartbeat(
  lastHeartbeatAt: string | undefined,
  now: Date,
): boolean {
  if (!lastHeartbeatAt) return true;

  const lastHeartbeatTime = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(lastHeartbeatTime)) return true;

  return now.getTime() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS;
}

function getCaptureUrl(analyticsConfig: InstanceAnalyticsConfig): string {
  return new URL("/capture/", analyticsConfig.posthog.host).toString();
}

function getStateFilePath(stateDir: string): string {
  return path.join(stateDir, STATE_FILE_NAME);
}
