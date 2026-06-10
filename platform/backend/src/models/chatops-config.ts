import { SLACK_DEFAULT_CONNECTION_MODE } from "@/agents/chatops/constants";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type {
  MsTeamsDbConfig,
  NgrokDbConfig,
  SecretValue,
  SlackDbConfig,
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
    const [ms, slack, ngrok] = await Promise.all([
      this.getMsTeamsConfig(),
      this.getSlackConfig(),
      this.getNgrokConfig(),
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
