import { inArray, sql } from "drizzle-orm";
import { SLACK_DEFAULT_CONNECTION_MODE } from "@/agents/chatops/constants";
import { schema, type Transaction, withDbTransaction } from "@/database";
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
import { decryptSecretValue, isEncryptedSecret } from "@/utils/crypto";
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
    await this.saveSlackDiscoveryConfig(
      SLACK_SECRET_NAME,
      value as unknown as SecretValue,
    );
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

  /** Fence publication against settings saves, including first-time bot insertion. */
  async getSlackDiscoveryConfigs(tx: Transaction): Promise<{
    main: SlackDbConfig | null;
    bots: SlackAgentBotConfig[];
  }> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"slack-discovery-config"}, 0))`,
    );
    const rows = await tx
      .select()
      .from(schema.secretsTable)
      .where(
        inArray(schema.secretsTable.name, [
          SLACK_SECRET_NAME,
          SLACK_AGENT_BOTS_SECRET_NAME,
        ]),
      );
    const values = new Map(
      rows.map((row) => {
        if (row.isVault)
          throw new Error(
            "Slack discovery requires database-stored configuration",
          );
        return [
          row.name,
          isEncryptedSecret(row.secret)
            ? decryptSecretValue(row.secret)
            : row.secret,
        ];
      }),
    );
    const main = values.get(SLACK_SECRET_NAME) as unknown as
      | SlackDbConfig
      | undefined;
    const bots = values.get(SLACK_AGENT_BOTS_SECRET_NAME) as unknown as
      | { bots?: SlackAgentBotConfig[] }
      | undefined;
    return {
      main: main ? normalizeSlackConfig(main) : null,
      bots: bots?.bots ?? [],
    };
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

  /**
   * A user's Slack app configuration token. Without a user, the
   * organization-wide token saved before tokens were per user.
   */
  async getSlackAppConfigToken(
    userId?: string,
  ): Promise<SlackAppConfigToken | null> {
    return this.getConfig<SlackAppConfigToken>(
      appConfigTokenSecretName(userId),
    );
  }

  async saveSlackAppConfigToken(
    value: SlackAppConfigToken,
    userId?: string,
  ): Promise<void> {
    await this.saveConfig(
      appConfigTokenSecretName(userId),
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

  private async saveSlackDiscoveryConfig(
    name: string,
    value: SecretValue,
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"slack-discovery-config"}, 0))`,
      );
      const row = await SecretModel.findByName(name, tx);
      if (row) await SecretModel.update(row.id, { secret: value }, tx);
      else
        await SecretModel.create({ name, secret: value, isVault: false }, tx);
    });
  }

  private async saveSlackAgentBots(bots: SlackAgentBotConfig[]): Promise<void> {
    await this.saveSlackDiscoveryConfig(SLACK_AGENT_BOTS_SECRET_NAME, {
      bots,
    } as unknown as SecretValue);
  }

  private async getConfig<T>(secretName: string): Promise<T | null> {
    const secretRow = await SecretModel.findByName(secretName);
    if (!secretRow) return null;

    // Slack configuration is fenced across replicas; a process-local secret
    // cache must not resurrect the configuration from before a settings save.
    const secret = await secretManager().getSecret(secretRow.id, {
      skipCache:
        secretName === SLACK_SECRET_NAME ||
        secretName === SLACK_AGENT_BOTS_SECRET_NAME,
    });
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

function appConfigTokenSecretName(userId?: string): string {
  return userId
    ? `${SLACK_APP_CONFIG_TOKEN_SECRET_NAME}:${userId}`
    : SLACK_APP_CONFIG_TOKEN_SECRET_NAME;
}

function normalizeSlackConfig(raw: SlackDbConfig): SlackDbConfig {
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
