import config from "@/config";
import logger from "@/logging";
import { OrganizationModel } from "@/models";

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const CAPTURE_TIMEOUT_MS = 10_000;
const INSTANCE_STARTED_EVENT = "instance_started";
const INSTANCE_HEARTBEAT_EVENT = "instance_heartbeat";

type Fetch = typeof fetch;

type InstanceAnalyticsConfig = {
  enabled: boolean;
  posthog: {
    key: string;
    host: string;
  };
};

class InstanceAnalyticsService {
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      analyticsConfig?: InstanceAnalyticsConfig;
      appVersion?: string;
      fetch?: Fetch;
      now?: () => Date;
    } = {},
  ) {}

  // The hourly re-check is what makes instance_heartbeat a daily signal for
  // long-running instances: with a startup-only capture, an always-on
  // deployment reports once at boot and then never again until its next
  // restart, so "active instances" charts only count restarts.
  async start(): Promise<void> {
    const analyticsConfig = this.getAnalyticsConfig();
    if (!analyticsConfig.enabled || !analyticsConfig.posthog.key) return;

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.captureDueEvents().catch((error) => {
          logger.warn(
            { err: error },
            "Failed to send instance analytics heartbeat",
          );
        });
      }, HEARTBEAT_CHECK_INTERVAL_MS);
      this.heartbeatTimer.unref();
    }

    await this.captureDueEvents();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async captureDueEvents(): Promise<void> {
    const analyticsConfig = this.getAnalyticsConfig();
    if (!analyticsConfig.enabled || !analyticsConfig.posthog.key) return;

    const now = this.getNow();
    const state = await OrganizationModel.getAnalyticsState();

    if (!state.analyticsInstanceStartedAt) {
      await this.capture({
        analyticsConfig,
        event: INSTANCE_STARTED_EVENT,
        distinctId: state.analyticsInstanceId,
      });
      await OrganizationModel.updateAnalyticsState({
        id: state.id,
        analyticsInstanceStartedAt: now,
      });
    }

    if (shouldSendHeartbeat(state.analyticsInstanceLastHeartbeatAt, now)) {
      await this.capture({
        analyticsConfig,
        event: INSTANCE_HEARTBEAT_EVENT,
        distinctId: state.analyticsInstanceId,
      });
      await OrganizationModel.updateAnalyticsState({
        id: state.id,
        analyticsInstanceLastHeartbeatAt: now,
      });
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
          instance_id: distinctId,
          source: "backend",
          $groups: {
            instance: distinctId,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `PostHog capture failed with status ${response.status} ${response.statusText}`,
      );
    }
  }

  private getAnalyticsConfig(): InstanceAnalyticsConfig {
    return this.options.analyticsConfig ?? config.analytics;
  }

  private getFetch(): Fetch {
    return this.options.fetch ?? fetch;
  }

  private getNow(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export const instanceAnalyticsService = new InstanceAnalyticsService();

function shouldSendHeartbeat(lastHeartbeatAt: Date | null, now: Date): boolean {
  if (!lastHeartbeatAt) return true;

  return now.getTime() - lastHeartbeatAt.getTime() >= HEARTBEAT_INTERVAL_MS;
}

function getCaptureUrl(analyticsConfig: InstanceAnalyticsConfig): string {
  return new URL("/capture/", analyticsConfig.posthog.host).toString();
}
