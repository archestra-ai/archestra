import { expect, test } from "vitest";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import {
  extractLocalConfigSecrets,
  getCatalogSecretValues,
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
    (
      await secretManager().getSecret(result.secretId ?? "", {
        skipCache: true,
      })
    )?.secret,
  ).toEqual({});
});

test("changing a catalog secret stages a new bag without modifying the running catalog's bag", async () => {
  const original = await secretManager().createSecret(
    { TOKEN: "approved-value" },
    "catalog-original",
  );
  const result = await extractLocalConfigSecrets({
    catalogName: "Edited catalog",
    existingSecretId: original.id,
    localConfig: {
      command: "node",
      environment: [
        {
          key: "TOKEN",
          type: "secret",
          promptOnInstallation: false,
          value: "proposed-value",
        },
      ],
    },
  });
  expect((await secretManager().getSecret(original.id))?.secret).toEqual({
    TOKEN: "approved-value",
  });
  expect(result.secretId).not.toBe(original.id);
  expect(
    (await secretManager().getSecret(result.secretId ?? ""))?.secret,
  ).toEqual({
    TOKEN: "proposed-value",
  });
});

test("an unchanged catalog secret keeps its existing bag", async () => {
  const original = await secretManager().createSecret(
    { TOKEN: "approved-value" },
    "catalog-original",
  );
  const result = await extractLocalConfigSecrets({
    catalogName: "Edited catalog",
    existingSecretId: original.id,
    localConfig: {
      command: "node",
      environment: [
        {
          key: "TOKEN",
          type: "secret",
          promptOnInstallation: false,
          value: "approved-value",
        },
      ],
    },
  });
  expect(result.secretId).toBe(original.id);
  expect(result.rotated).toBe(false);
});

test("catalog authoring reads fresh values even when the secrets manager cached the old bag", async () => {
  const bag = await secretManager().createSecret(
    { TOKEN: "cached" },
    "catalog-bag",
  );
  await SecretModel.update(bag.id, { secret: { TOKEN: "fresh" } });
  expect(await getCatalogSecretValues(bag.id)).toEqual({ TOKEN: "fresh" });
});

test("copying a BYOS catalog retains external references", async () => {
  const original = await SecretModel.create({
    name: "external-catalog-bag",
    isByosVault: true,
    secret: { TOKEN: "secret/catalog#token" },
  });
  const result = await extractLocalConfigSecrets({
    catalogName: "Catalog",
    existingSecretId: original.id,
    localConfig: {
      command: "node",
      environment: [
        { key: "TOKEN", type: "secret", promptOnInstallation: false },
      ],
    },
  });
  expect(result.secretId).toBe(original.id);
  expect(await getCatalogSecretValues(result.secretId)).toEqual({
    TOKEN: "secret/catalog#token",
  });
  expect((await SecretModel.findById(original.id))?.isByosVault).toBe(true);
});

test("hydrated values preserve legacy inline fields and the current bag", async () => {
  const stored = await secretManager().createSecret(
    {
      TOKEN: "current-token",
      "__regcred_password:registry.example:user": "current-password",
    },
    "existing-config",
  );
  const existingLocalConfig = {
    environment: [
      {
        key: "TOKEN",
        type: "secret" as const,
        promptOnInstallation: false,
        value: "legacy-token",
      },
    ],
    imagePullSecrets: [
      {
        source: "credentials" as const,
        server: "registry.example",
        username: "user",
        password: "legacy-password",
      },
    ],
  };
  const prepared = await extractLocalConfigSecrets({
    catalogName: "Config roundtrip",
    existingSecretId: stored.id,
    existingLocalConfig,
    localConfig: {
      environment: [
        { ...existingLocalConfig.environment[0], value: "current-token" },
      ],
      imagePullSecrets: [
        {
          ...existingLocalConfig.imagePullSecrets[0],
          password: "current-password",
        },
      ],
    },
  });
  expect(prepared.secretId).toBe(stored.id);
  expect(prepared.rotated).toBe(false);
  expect(prepared.localConfig).toEqual(existingLocalConfig);
});

test("client credential preparation retains unchanged inline values and stages changed values", async () => {
  const inline = await upsertCatalogClientSecretValue({
    catalogName: "Client roundtrip",
    clientSecretId: null,
    key: "client_secret",
    value: undefined,
    existingInlineValue: "legacy-client",
  });
  expect(inline).toEqual({
    id: null,
    rotated: false,
    inlineValue: "legacy-client",
  });
  const stored = await secretManager().createSecret(
    { client_secret: "current-client" },
    "client-bag",
  );
  const unchanged = await upsertCatalogClientSecretValue({
    catalogName: "Client roundtrip",
    clientSecretId: stored.id,
    key: "client_secret",
    value: "current-client",
    existingInlineValue: "legacy-client",
  });
  expect(unchanged).toEqual({
    id: stored.id,
    rotated: false,
    inlineValue: "legacy-client",
  });
  const changed = await upsertCatalogClientSecretValue({
    catalogName: "Client roundtrip",
    clientSecretId: stored.id,
    key: "client_secret",
    value: "updated-client",
    existingInlineValue: "legacy-client",
  });
  expect(changed.id).not.toBe(stored.id);
  expect(changed.inlineValue).toBeUndefined();
  expect((await secretManager().getSecret(stored.id))?.secret).toEqual({
    client_secret: "current-client",
  });
  expect((await secretManager().getSecret(changed.id ?? ""))?.secret).toEqual({
    client_secret: "updated-client",
  });
});
