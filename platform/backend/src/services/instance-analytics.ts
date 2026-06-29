import config from "@/config";
import { OrganizationModel } from "@/models";

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
  constructor(
    private readonly options: {
      analyticsConfig?: InstanceAnalyticsConfig;
      appVersion?: string;
      fetch?: Fetch;
      now?: () => Date;
    } = {},
  ) {}

  async trackStartup(): Promise<void> {
    const analyticsConfig = this.options.analyticsConfig ?? config.analytics;
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
