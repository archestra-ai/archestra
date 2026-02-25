import { SupportedProviders } from "@shared";
import { describe, expect, test } from "@/test";
import { getSecretValueForLlmProviderApiKey } from "./index";

describe("getSecretValueForLlmProviderApiKey", () => {
  // =========================================================================
  // Current format
  // =========================================================================

  test("returns apiKey from current format", async ({ makeSecret }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-current" } });
    expect(await getSecretValueForLlmProviderApiKey(secret.id)).toBe(
      "sk-current",
    );
  });

  test("prefers apiKey over legacy keys when both exist", async ({
    makeSecret,
  }) => {
    const secret = await makeSecret({
      secret: { apiKey: "sk-current", anthropicApiKey: "sk-legacy" },
    });
    expect(await getSecretValueForLlmProviderApiKey(secret.id)).toBe(
      "sk-current",
    );
  });

  // =========================================================================
  // Legacy format — all supported providers
  // =========================================================================

  for (const provider of SupportedProviders) {
    const legacyKey = `${provider}ApiKey`;

    test(`returns ${legacyKey} from legacy format`, async ({ makeSecret }) => {
      const secret = await makeSecret({
        secret: { [legacyKey]: `sk-${provider}-legacy` },
      });
      expect(await getSecretValueForLlmProviderApiKey(secret.id)).toBe(
        `sk-${provider}-legacy`,
      );
    });
  }

  // =========================================================================
  // Edge cases
  // =========================================================================

  test("returns undefined for non-existent secret", async () => {
    expect(
      await getSecretValueForLlmProviderApiKey(
        "00000000-0000-0000-0000-000000000000",
      ),
    ).toBeUndefined();
  });

  test("returns undefined when secret has no recognized key", async ({
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { unrelated: "value" } });
    expect(await getSecretValueForLlmProviderApiKey(secret.id)).toBeUndefined();
  });

  test("returns undefined when apiKey is not a string", async ({
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: 12345 } });
    expect(await getSecretValueForLlmProviderApiKey(secret.id)).toBeUndefined();
  });

  test("returns undefined for empty secret object", async ({ makeSecret }) => {
    const secret = await makeSecret({ secret: {} });
    expect(await getSecretValueForLlmProviderApiKey(secret.id)).toBeUndefined();
  });
});
