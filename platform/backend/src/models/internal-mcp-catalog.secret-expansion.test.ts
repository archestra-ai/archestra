import { vi } from "vitest";
import { secretManager } from "@/secrets-manager";
import { expect, test } from "@/test";
import { deriveKeyFromSecret, encryptSecretValueWithKey } from "@/utils/crypto";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import SecretModel from "./secret";

// Spying on the (real) secrets-manager instance keeps this file free of module
// mocks, so it runs in the fast "clean" vitest project.
test("catalog secret expansion degrades gracefully when a single secret fails to resolve", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const secret = await SecretModel.create({
    name: `expand-fail-${crypto.randomUUID().slice(0, 8)}`,
    secret: { API_KEY: "shh" },
  });
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    localConfigSecretId: secret.id,
  });

  const getSecretSpy = vi
    .spyOn(secretManager(), "getSecret")
    .mockRejectedValue(new Error("secrets backend unavailable"));

  // Before the fix, one rejected getSecret rejected the whole Promise.all in
  // expandSecrets and 5xx-ed the catalog tools listing. The listing must now
  // resolve, simply leaving the unresolvable secret unpopulated.
  const result = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: true,
  });

  // The failing secret was actually reached (the resolve path ran) ...
  expect(getSecretSpy).toHaveBeenCalledWith(secret.id);
  // ... yet the read succeeded instead of throwing.
  expect(result?.id).toBe(catalog.id);

  getSecretSpy.mockRestore();
});

test("catalog metadata remains available when stored credentials use an unavailable key", async ({
  makeOrganization,
  makeInternalMcpCatalog,
}) => {
  const org = await makeOrganization();
  const secret = await SecretModel.create({
    name: "unreadable-catalog",
    secret: {},
  });
  await SecretModel.updateRawSecret(
    secret.id,
    encryptSecretValueWithKey(
      { API_KEY: "synthetic-token" },
      deriveKeyFromSecret("unavailable-test-key"),
    ),
  );
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    localConfigSecretId: secret.id,
    localConfig: {
      environment: [
        { key: "API_KEY", type: "secret", promptOnInstallation: false },
      ],
    },
  });
  const result = await InternalMcpCatalogModel.findById(catalog.id);
  expect(result?.localConfig?.environment?.[0]).not.toHaveProperty("value");
  expect(result?.localConfigSecretId).toBe(secret.id);
  await expect(
    InternalMcpCatalogModel.findByIdWithResolvedSecrets(catalog.id),
  ).rejects.toMatchObject({
    statusCode: 409,
    shouldRetry: false,
  });
  await SecretModel.update(secret.id, {
    secret: { API_KEY: "replacement-token" },
  });
  const recovered = await InternalMcpCatalogModel.findByIdWithResolvedSecrets(
    catalog.id,
  );
  expect(recovered?.localConfig?.environment?.[0].value).toBe(
    "replacement-token",
  );
});
