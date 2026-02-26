import { SLACK_DEFAULT_CONNECTION_MODE } from "@/agents/chatops/constants";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type { SecretValue } from "@/types";
import SecretModel from "./secret";

/**
 * ChatOps config secrets always use DB storage (forceDB: true) because:
 * 1. They are platform-internal config, not user-provided external secrets
 * 2. BYOS Vault (READONLY_VAULT) is read-only from the customer's Vault
 */
const FORCE_DB = true;

const MS_TEAMS_SECRET_NAME = "chatops-ms-teams";
const SLACK_SECRET_NAME = "chatops-slack";

export interface MsTeamsConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  tenantId: string;
  graphTenantId: string;
  graphClientId: string;
  graphClientSecret: string;
}

export interface SlackConfig {
  enabled: boolean;
  botToken: string;
  signingSecret: string;
  appId: string;
  connectionMode?: "webhook" | "socket";
  appLevelToken?: string;
}

class ChatOpsConfigModel {
  async getMsTeamsConfig(): Promise<MsTeamsConfig | null> {
    return this.getConfig<MsTeamsConfig>(MS_TEAMS_SECRET_NAME);
  }

  async getSlackConfig(): Promise<SlackConfig | null> {
    const raw = await this.getConfig<SlackConfig>(SLACK_SECRET_NAME);
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

  async saveMsTeamsConfig(value: MsTeamsConfig): Promise<void> {
    await this.saveConfig(
      MS_TEAMS_SECRET_NAME,
      value as unknown as SecretValue,
    );
    logger.info("ChatOpsConfigModel: saved MS Teams config to DB");
  }

  async saveSlackConfig(value: SlackConfig): Promise<void> {
    await this.saveConfig(SLACK_SECRET_NAME, value as unknown as SecretValue);
    logger.info("ChatOpsConfigModel: saved Slack config to DB");
  }

  private async getConfig<T>(secretName: string): Promise<T | null> {
    try {
      const secretRow = await SecretModel.findByName(secretName);
      if (!secretRow) return null;

      const secret = await secretManager().getSecret(secretRow.id);
      if (!secret?.secret) return null;

      return secret.secret as unknown as T;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        `ChatOpsConfigModel: failed to read config "${secretName}"`,
      );
      return null;
    }
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
