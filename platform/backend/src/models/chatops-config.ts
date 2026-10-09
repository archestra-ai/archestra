import { SLACK_DEFAULT_CONNECTION_MODE } from "@/agents/chatops/constants";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  MsTeamsDbConfig,
  NgrokDbConfig,
  SecretValue,
  SlackAgentBotConfig,
  SlackAppConfigToken,
  SlackDbConfig,
  TelegramDbConfig,
} from "@/types";
import SecretModel from "./secret";

/**
 * ChatOps config secrets always use DB storage (forceDB: true) because:
 * 1. They are platform-internal config, not user-provided external secrets
 * 2. BYOS Vault (READONLY_VAULT) is read-only from the customer's Vault
 */
const FORCE_DB = true;

const MS_TEAMS_SECRET_NAME = "chatops-ms-teams";
const SLACK_SECRET_NAME = "chatops-slack";
const SLACK_AGENT_BOTS_SECRET_NAME = "chatops-slack-agent-bots";
const SLACK_APP_CONFIG_TOKEN_SECRET_NAME = "chatops-slack-app-config-token";
const TELEGRAM_SECRET_NAME = "chatops-telegram";
const NGROK_SECRET_NAME = "chatops-ngrok";

class ChatOpsConfigModel {
  async getMsTeamsConfig(): Promise<MsTeamsDbConfig | null> {
    return this.getConfig<MsTeamsDbConfig>(MS_TEAMS_SECRET_NAME);
  }

  async getSlackConfig(): Promise<SlackDbConfig | null> {
    const raw = await this.getConfig<SlackDbConfig>(SLACK_SECRET_NAME);
    if (!raw) return null;
    // Backward compatibility — precedence:
    // 1. Explicit connectionMode from DB (already set by user)
    // 2. Infer "webhook" if signingSecret is present but connectionMode is missing
    //    (configs saved before socket mode was added)
    // 3. Default to SLACK_DEFAULT_CONNECTION_MODE ("socket") for new installs
    const inferredMode =
      !raw.connectionMode && raw.signingSecret
        ? "webhook"
        : (raw.connectionMode ?? SLACK_DEFAULT_CONNECTION_MODE);

    return {
      ...raw,
      connectionMode: inferredMode,
      appLevelToken: raw.appLevelToken ?? "",
    };
  }

  async saveMsTeamsConfig(value: MsTeamsDbConfig): Promise<void> {
    await this.saveConfig(
      MS_TEAMS_SECRET_NAME,
      value as unknown as SecretValue,
    );
    logger.info("ChatOpsConfigModel: saved MS Teams config to DB");
  }

  async saveSlackConfig(value: SlackDbConfig): Promise<void> {
    await this.saveConfig(SLACK_SECRET_NAME, value as unknown as SecretValue);
    logger.info("ChatOpsConfigModel: saved Slack config to DB");
  }

  /** Slack apps pinned to one agent each (see SlackAgentBotConfig). */
  async getSlackAgentBots(): Promise<SlackAgentBotConfig[]> {
    const raw = await this.getConfig<{ bots?: SlackAgentBotConfig[] }>(
      SLACK_AGENT_BOTS_SECRET_NAME,
    );
    return (raw?.bots ?? []).map((bot) => ({
      ...bot,
      connectionMode: bot.connectionMode ?? SLACK_DEFAULT_CONNECTION_MODE,
      appLevelToken: bot.appLevelToken ?? "",
    }));
  }

  /** Add or replace the bot pinned to `bot.agentId`. */
  async saveSlackAgentBot(bot: SlackAgentBotConfig): Promise<void> {
    const bots = await this.getSlackAgentBots();
    await this.saveSlackAgentBots([
      ...bots.filter((existing) => existing.agentId !== bot.agentId),
      bot,
    ]);
    logger.info(
      { agentId: bot.agentId },
      "ChatOpsConfigModel: saved Slack agent bot",
    );
  }

  async getSlackAppConfigToken(): Promise<SlackAppConfigToken | null> {
    return this.getConfig<SlackAppConfigToken>(
      SLACK_APP_CONFIG_TOKEN_SECRET_NAME,
    );
  }

  async saveSlackAppConfigToken(value: SlackAppConfigToken): Promise<void> {
    await this.saveConfig(
      SLACK_APP_CONFIG_TOKEN_SECRET_NAME,
      value as unknown as SecretValue,
    );
  }

  /** Remove the bot pinned to an agent. Returns whether one existed. */
  async deleteSlackAgentBot(agentId: string): Promise<boolean> {
    const bots = await this.getSlackAgentBots();
    const remaining = bots.filter((bot) => bot.agentId !== agentId);
    if (remaining.length === bots.length) return false;
    await this.saveSlackAgentBots(remaining);
    logger.info({ agentId }, "ChatOpsConfigModel: deleted Slack agent bot");
    return true;
  }

  async getTelegramConfig(): Promise<TelegramDbConfig | null> {
    return this.getConfig<TelegramDbConfig>(TELEGRAM_SECRET_NAME);
  }

  async saveTelegramConfig(value: TelegramDbConfig): Promise<void> {
    await this.saveConfig(
      TELEGRAM_SECRET_NAME,
      value as unknown as SecretValue,
    );
    logger.info("ChatOpsConfigModel: saved Telegram config to DB");
  }

  async getNgrokConfig(): Promise<NgrokDbConfig | null> {
    return this.getConfig<NgrokDbConfig>(NGROK_SECRET_NAME);
  }

  async saveNgrokConfig(value: NgrokDbConfig): Promise<void> {
    await this.saveConfig(NGROK_SECRET_NAME, value as unknown as SecretValue);
    logger.info("ChatOpsConfigModel: saved ngrok config to DB");
  }

  /**
   * Non-secret ChatOps connectivity snapshot for audit diffs.
   */
  async getRedactedSnapshotForAudit(): Promise<Record<string, unknown>> {
    const [ms, slack, telegram, ngrok, slackAgentBots, slackAppConfigToken] =
      await Promise.all([
        this.getMsTeamsConfig(),
        this.getSlackConfig(),
        this.getTelegramConfig(),
        this.getNgrokConfig(),
        this.getSlackAgentBots(),
        this.getSlackAppConfigToken(),
      ]);

    return {
      msTeams: ms
        ? {
            enabled: ms.enabled,
            hasAppId: Boolean(ms.appId),
            hasAppSecret: Boolean(ms.appSecret),
            hasTenantId: Boolean(ms.tenantId),
          }
        : null,
      slack: slack
        ? {
            enabled: slack.enabled,
            connectionMode: slack.connectionMode,
            hasBotToken: Boolean(slack.botToken),
            hasSigningSecret: Boolean(slack.signingSecret),
            hasAppId: Boolean(slack.appId),
            hasAppLevelToken: Boolean(slack.appLevelToken),
          }
        : null,
      hasSlackAppConfigToken: Boolean(slackAppConfigToken),
      slackAgentBots: slackAgentBots.map((bot) => ({
        agentId: bot.agentId,
        enabled: bot.enabled,
        connectionMode: bot.connectionMode,
        hasBotToken: Boolean(bot.botToken),
      })),
      telegram: telegram
        ? {
            enabled: telegram.enabled,
            hasBotToken: Boolean(telegram.botToken),
          }
        : null,
      ngrok: ngrok
        ? {
            hasAuthToken: Boolean(ngrok.authToken),
            hasDomain: Boolean(ngrok.domain),
          }
        : null,
    };
  }

  private async saveSlackAgentBots(bots: SlackAgentBotConfig[]): Promise<void> {
    await this.saveConfig(SLACK_AGENT_BOTS_SECRET_NAME, {
      bots,
    } as unknown as SecretValue);
  }

  private async getConfig<T>(secretName: string): Promise<T | null> {
    const secretRow = await SecretModel.findByName(secretName);
    if (!secretRow) return null;

    const secret = await secretManager().getSecret(secretRow.id);
    if (!secret?.secret) return null;

    return secret.secret as unknown as T;
  }

  private async saveConfig(
    secretName: string,
    value: SecretValue,
  ): Promise<void> {
    const existing = await SecretModel.findByName(secretName);

    if (existing) {
      await secretManager().updateSecret(existing.id, value);
    } else {
      await secretManager().createSecret(value, secretName, FORCE_DB);
    }
  }
}

export default new ChatOpsConfigModel();
