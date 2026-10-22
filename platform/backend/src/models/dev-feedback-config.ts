import { secretManager } from "@/secrets-manager";
import type { SecretValue } from "@/types";
import type { DevFeedbackSetup } from "@/types/dev-feedback";
import SecretModel from "./secret";

/**
 * Which chatops Slack bot the UI feedback overlay posts as, and to which
 * channel. Kept in the secret store beside the chatops config it points into
 * (always the database, for the same reason as chatops: it is platform
 * config, and a read-only customer Vault cannot take writes). It holds no
 * credential itself: the bot's token stays in the chatops config.
 */
class DevFeedbackConfigModel {
  async get(): Promise<DevFeedbackSetup | null> {
    const row = await SecretModel.findByName(SECRET_NAME);
    if (!row) return null;
    const secret = await secretManager().getSecret(row.id);
    return (secret?.secret as unknown as DevFeedbackSetup | undefined) ?? null;
  }

  async save(value: DevFeedbackSetup): Promise<void> {
    const existing = await SecretModel.findByName(SECRET_NAME);
    const secret = value as unknown as SecretValue;
    if (existing) {
      await secretManager().updateSecret(existing.id, secret);
    } else {
      await secretManager().createSecret(secret, SECRET_NAME, true);
    }
  }
}

export default new DevFeedbackConfigModel();

// ===

const SECRET_NAME = "dev-feedback-slack";
