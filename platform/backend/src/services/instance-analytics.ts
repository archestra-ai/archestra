import config from "@/config";
import logger from "@/logging";
import { InstanceUsageModel, OrganizationModel } from "@/models";
import type { InstanceEntityCounts } from "@/types";

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
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

  // instance_heartbeat is a stateless hourly ping carrying the instance id;
  // dashboards count unique ids per day (DAU semantics), so restarts and
  // extra replicas can only duplicate events, never inflate the daily count.
  // Deliberately no send-once-per-day dedup state: a startup-only or
  // DB-deduped capture undercounts always-on deployments.
  async start(): Promise<void> {
    const analyticsConfig = this.getAnalyticsConfig();
    if (!analyticsConfig.enabled || !analyticsConfig.posthog.key) return;

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.captureHeartbeat().catch((error) => {
          logger.warn(
            { err: error },
            "Failed to send instance analytics heartbeat",
          );
        });
      }, HEARTBEAT_INTERVAL_MS);
      this.heartbeatTimer.unref();
    }

    await this.captureHeartbeat();
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async captureHeartbeat(): Promise<void> {
    const analyticsConfig = this.getAnalyticsConfig();
    if (!analyticsConfig.enabled || !analyticsConfig.posthog.key) return;

    const state = await OrganizationModel.getAnalyticsState();

    if (!state.analyticsInstanceStartedAt) {
      await this.capture({
        analyticsConfig,
        event: INSTANCE_STARTED_EVENT,
        distinctId: state.analyticsInstanceId,
      });
      await OrganizationModel.updateAnalyticsState({
        id: state.id,
        analyticsInstanceStartedAt: this.getNow(),
      });
    }

    await this.capture({
      analyticsConfig,
      event: INSTANCE_HEARTBEAT_EVENT,
      distinctId: state.analyticsInstanceId,
      extraProperties: await this.collectEntityCountProperties(),
    });
  }

  // Best effort: a failed count query must not cost us the heartbeat itself.
  private async collectEntityCountProperties(): Promise<
    Record<string, number>
  > {
    try {
      return getEntityCountProperties(
        await InstanceUsageModel.getEntityCounts(),
      );
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to collect instance entity counts for analytics heartbeat",
      );
      return {};
    }
  }

  private async capture({
    analyticsConfig,
    event,
    distinctId,
    extraProperties,
  }: {
    analyticsConfig: InstanceAnalyticsConfig;
    event: string;
    distinctId: string;
    extraProperties?: Record<string, number>;
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
          ...extraProperties,
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

function getCaptureUrl(analyticsConfig: InstanceAnalyticsConfig): string {
  return new URL("/capture/", analyticsConfig.posthog.host).toString();
}

function getEntityCountProperties(
  counts: InstanceEntityCounts,
): Record<string, number> {
  return {
    user_count: counts.users,
    team_count: counts.teams,
    agent_count: counts.agents,
    profile_count: counts.profiles,
    mcp_gateway_count: counts.mcpGateways,
    llm_proxy_count: counts.llmProxies,
    llm_provider_count: counts.llmProviders,
    virtual_api_key_count: counts.virtualApiKeys,
    mcp_server_count: counts.mcpServers,
    conversation_count: counts.conversations,
    skill_count: counts.skills,
    app_count: counts.apps,
    knowledge_base_count: counts.knowledgeBases,
  };
}
