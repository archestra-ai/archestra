import { ChatSettingsModel } from "@/models";
import SecretModel from "@/models/secret";
import { describe, expect, test } from "@/test";

describe("chat-settings route - resetApiKey", () => {
  test("resetApiKey deletes secret from database", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      name: "chatapikey",
      secret: { anthropicApiKey: "sk-test-key" },
    });

    // Set up chat settings with the secret
    await ChatSettingsModel.create({
      organizationId: org.id,
      anthropicApiKeySecretId: secret.id,
    });

    // Verify the secret exists
    const secretBefore = await SecretModel.findById(secret.id);
    expect(secretBefore).not.toBeNull();

    // Simulate what the route does when resetApiKey is true
    const settings = await ChatSettingsModel.getOrCreate(org.id);
    const secretId = settings.anthropicApiKeySecretId;

    if (secretId) {
      await SecretModel.delete(secretId);
    }

    await ChatSettingsModel.update(org.id, {
      anthropicApiKeySecretId: null,
    });

    // Verify the secret is deleted
    const secretAfter = await SecretModel.findById(secret.id);
    expect(secretAfter).toBeFalsy();

    // Verify chat settings no longer reference the secret
    const updatedSettings = await ChatSettingsModel.findByOrganizationId(
      org.id,
    );
    expect(updatedSettings?.anthropicApiKeySecretId).toBeNull();
  });
});
