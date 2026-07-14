import { vi } from "vitest";
import { secretManager } from "@/secrets-manager";
import { expect, test } from "@/test";
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
