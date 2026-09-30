import { SLACK_DEFAULT_CONNECTION_MODE } from "@/agents/chatops/constants";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  MsTeamsDbConfig,
  NgrokDbConfig,
  SecretValue,
  SlackDbConfig,
  TelegramDbConfig,
} from "@/types";
import type { ChatOpsBot } from "@/types/chatops-bot";
import ChatOpsBotModel from "./chatops-bot";
import SecretModel from "./secret";

/**
 * ChatOps config secrets always use DB storage (forceDB: true) because:
 * 1. They are platform-internal config, not user-provided external secrets
 * 2. BYOS Vault (READONLY_VAULT) is read-only from the customer's Vault
 */
const FORCE_DB = true;

const MS_TEAMS_SECRET_NAME = "chatops-ms-teams";
const SLACK_SECRET_NAME_PREFIX = "chatops-slack";
const TELEGRAM_SECRET_NAME = "chatops-telegram";
const NGROK_SECRET_NAME = "chatops-ngrok";
const SLACK_ENV_SEEDING_DISABLED_SECRET_NAME =
  "chatops-slack-env-seeding-disabled";

class ChatOpsConfigModel {
  async getMsTeamsConfig(): Promise<MsTeamsDbConfig | null> {
    return this.getConfig<MsTeamsDbConfig>(MS_TEAMS_SECRET_NAME);
  }

  /**
   * Slack credentials and transport settings of one Slack App. The secret the
   * bot row points at is the source of truth; the first Slack App keeps the
   * secret the singleton configuration used.
   */
  async getSlackConfig(
    bot: Pick<ChatOpsBot, "secretId">,
  ): Promise<SlackDbConfig | null> {
    if (!bot.secretId) return null;
    const raw = await this.getConfigBySecretId<SlackDbConfig>(bot.secretId);
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

  /**
   * Persist a Slack App's configuration, creating its secret on first save.
   * Returns the bot row, which carries the secret pointer after a first save.
   */
  async saveSlackConfig(params: {
    bot: ChatOpsBot;
    value: SlackDbConfig;
  }): Promise<ChatOpsBot> {
    const { bot, value } = params;
    const secretValue = value as unknown as SecretValue;
    if (bot.secretId) {
      await secretManager().updateSecret(bot.secretId, secretValue);
      logger.info({ botId: bot.id }, "ChatOpsConfigModel: saved Slack config");
      return bot;
    }
    const secret = await secretManager().createSecret(
      secretValue,
      `${SLACK_SECRET_NAME_PREFIX}-${bot.id}`,
      FORCE_DB,
    );
    const updated = await ChatOpsBotModel.update(bot.id, {
      secretId: secret.id,
    });
    logger.info({ botId: bot.id }, "ChatOpsConfigModel: saved Slack config");
    return updated ?? { ...bot, secretId: secret.id };
  }

  /**
   * Whether an admin ever removed a Slack App. Environment variables seed the
   * first Slack App only while nothing records a removal, so a restart never
   * brings a deliberately removed app back from its env credentials.
   */
  async isSlackEnvSeedingDisabled(): Promise<boolean> {
    return (
      (await this.getConfig<{ disabled: boolean }>(
        SLACK_ENV_SEEDING_DISABLED_SECRET_NAME,
      )) !== null
    );
  }

  async disableSlackEnvSeeding(): Promise<void> {
    await this.saveConfig(SLACK_ENV_SEEDING_DISABLED_SECRET_NAME, {
      disabled: true,
    } as unknown as SecretValue);
  }

  /** Drop a Slack App's stored credentials (used when the app is removed). */
  async deleteSlackConfig(bot: Pick<ChatOpsBot, "secretId">): Promise<void> {
    if (!bot.secretId) return;
    await secretManager().deleteSecret(bot.secretId);
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
  async getRedactedSnapshotForAudit(
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const [ms, telegram, ngrok, slackBots] = await Promise.all([
      this.getMsTeamsConfig(),
      this.getTelegramConfig(),
      this.getNgrokConfig(),
      ChatOpsBotModel.findByProvider({ organizationId, provider: "slack" }),
    ]);
    const slack = await Promise.all(
      slackBots.map(async (bot) => {
        const config = await this.getSlackConfig(bot);
        return {
          botId: bot.id,
          name: bot.name,
          enabled: config?.enabled ?? false,
          connectionMode: config?.connectionMode,
          hasBotToken: Boolean(config?.botToken),
          hasSigningSecret: Boolean(config?.signingSecret),
          hasAppId: Boolean(config?.appId),
          hasAppLevelToken: Boolean(config?.appLevelToken),
        };
      }),
    );

    return {
      msTeams: ms
        ? {
            enabled: ms.enabled,
            hasAppId: Boolean(ms.appId),
            hasAppSecret: Boolean(ms.appSecret),
            hasTenantId: Boolean(ms.tenantId),
          }
        : null,
      slack,
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

  private async getConfig<T>(secretName: string): Promise<T | null> {
    const secretRow = await SecretModel.findByName(secretName);
    if (!secretRow) return null;
    return this.getConfigBySecretId<T>(secretRow.id);
  }

  private async getConfigBySecretId<T>(secretId: string): Promise<T | null> {
    const secret = await secretManager().getSecret(secretId);
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
