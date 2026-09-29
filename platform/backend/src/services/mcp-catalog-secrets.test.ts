import { expect, test } from "vitest";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import {
  extractLocalConfigSecrets,
  getCatalogSecretValues,
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
