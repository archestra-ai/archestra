import { expect, test } from "vitest";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { deriveKeyFromSecret, encryptSecretValueWithKey } from "@/utils/crypto";
import {
  extractLocalConfigSecrets,
  upsertCatalogClientSecretValue,
} from "./mcp-catalog-secrets";

test("saved credential bindings never copy a value into the catalog or its secret bag", async () => {
  const result = await extractLocalConfigSecrets({
    catalogName: "Credential check",
    existingSecretId: null,
    localConfig: {
      environment: [
        {
          key: "TOKEN",
          type: "secret",
          credentialId: "repository",
          credentialScope: "organization",
          promptOnInstallation: false,
          value: "must-not-be-copied",
        },
      ],
    },
  });
  expect(result.localConfig?.environment?.[0]).not.toHaveProperty("value");
  expect(result.localConfig?.environment?.[0].credentialId).toBe("repository");
  expect(result.secretId).toBeNull();
});

test("client-secret recovery requires every configured key before replacing the bag", async () => {
  const secret = await SecretModel.create({
    name: "shared-client-secrets",
    secret: {},
  });
  const encrypted = encryptSecretValueWithKey(
    { client_secret: "old-client", other_client_secret: "old-other" },
    deriveKeyFromSecret("unavailable-test-key"),
  );
  await SecretModel.updateRawSecret(secret.id, encrypted);
  const params = {
    clientSecretId: secret.id,
    catalogName: "Shared credentials",
    key: "client_secret",
    value: "new-client",
  };
  await expect(
    upsertCatalogClientSecretValue({
      ...params,
      recovery: {
        requiredKeys: ["client_secret", "other_client_secret"],
        values: { client_secret: "new-client" },
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(
    (await SecretModel.findAllRaw()).find((row) => row.id === secret.id)
      ?.secret,
  ).toEqual(encrypted);
  const result = await upsertCatalogClientSecretValue({
    ...params,
    recovery: {
      requiredKeys: ["client_secret", "other_client_secret"],
      values: { client_secret: "new-client", other_client_secret: "new-other" },
    },
  });
  expect(result.id).not.toBe(secret.id);
  expect((await secretManager().getSecret(result.id))?.secret).toEqual({
    client_secret: "new-client",
    other_client_secret: "new-other",
  });
});

test("recovery rejects an omitted registry password surface and preserves the unreadable bag", async () => {
  const secret = await SecretModel.create({
    name: "unreadable-registry",
    secret: {},
  });
  const encrypted = encryptSecretValueWithKey(
    {
      TOKEN: "old-token",
      "__regcred_password:example.invalid:user": "old-password",
    },
    deriveKeyFromSecret("unavailable-test-key"),
  );
  await SecretModel.updateRawSecret(secret.id, encrypted);
  const imagePullSecrets = [
    {
      source: "credentials" as const,
      server: "example.invalid",
      username: "user",
    },
  ];
  const environment = [
    { key: "TOKEN", type: "secret" as const, promptOnInstallation: false },
  ];
  const params = {
    catalogName: "Recovery",
    existingSecretId: secret.id,
    existingLocalConfig: { environment, imagePullSecrets },
  };
  await expect(
    extractLocalConfigSecrets({
      ...params,
      localConfig: { environment: [{ ...environment[0], value: "new-token" }] },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(
    (await SecretModel.findAllRaw()).find((row) => row.id === secret.id)
      ?.secret,
  ).toEqual(encrypted);
  const recovered = await extractLocalConfigSecrets({
    ...params,
    localConfig: {
      environment: [{ ...environment[0], value: "new-token" }],
      imagePullSecrets: [{ ...imagePullSecrets[0], password: "new-password" }],
    },
  });
  if (!recovered.secretId) throw new Error("Recovery did not create a secret");
  expect((await secretManager().getSecret(recovered.secretId))?.secret).toEqual(
    {
      TOKEN: "new-token",
      "__regcred_password:example.invalid:user": "new-password",
    },
  );
  expect(recovered.localConfig?.imagePullSecrets?.[0]).not.toHaveProperty(
    "password",
  );
});

test("switching the last inline secret to a saved credential removes the obsolete stored value", async () => {
  const secret = await secretManager().createSecret(
    { TOKEN: "old-inline-secret" },
    "catalog-secret",
  );
  const result = await extractLocalConfigSecrets({
    catalogName: "Credential check",
    existingSecretId: secret.id,
    localConfig: {
      environment: [
        {
          key: "TOKEN",
          type: "secret",
          credentialId: "repository",
          credentialScope: "organization",
          promptOnInstallation: false,
        },
      ],
    },
  });
  expect(result.rotated).toBe(true);
  expect(
    (await secretManager().getSecret(secret.id, { skipCache: true }))?.secret,
  ).toEqual({});
});
