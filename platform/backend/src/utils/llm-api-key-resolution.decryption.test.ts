import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { expect, test } from "@/test";
import { deriveKeyFromSecret, encryptSecretValueWithKey } from "@/utils/crypto";
import { resolveProviderApiKey } from "./llm-api-key-resolution";

test("chat provider resolution refuses unreadable credentials and succeeds after replacement", async ({
  makeOrganization,
  makeLlmProviderApiKey,
}) => {
  const organization = await makeOrganization();
  const secret = await SecretModel.create({
    name: "unreadable-provider",
    secret: {},
  });
  await SecretModel.updateRawSecret(
    secret.id,
    encryptSecretValueWithKey(
      { apiKey: "old-synthetic-key" },
      deriveKeyFromSecret("unavailable-test-key"),
    ),
  );
  await makeLlmProviderApiKey(organization.id, secret.id, {
    provider: "openai",
  });
  const params = {
    organizationId: organization.id,
    provider: "openai" as const,
  };
  await expect(resolveProviderApiKey(params)).rejects.toMatchObject({
    statusCode: 409,
    shouldRetry: false,
  });
  await secretManager().updateSecret(secret.id, {
    apiKey: "replacement-synthetic-key",
  });
  expect((await resolveProviderApiKey(params)).apiKey).toBe(
    "replacement-synthetic-key",
  );
});
