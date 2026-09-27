import { expect, test } from "vitest";
import { secretManager } from "@/secrets-manager";
import { extractLocalConfigSecrets } from "./mcp-catalog-secrets";

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
    (await secretManager().getSecret(secret.id, { skipCache: true }))?.secret,
  ).toEqual({});
});
