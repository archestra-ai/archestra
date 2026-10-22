import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { describe, expect, test } from "@/test";
import { encodeOpenAiCodexCredential } from "./openai-codex-credentials";
import { resolveVirtualKeyProviderMappings } from "./virtual-key-providers";

describe("automatic virtual key providers", () => {
  test("adds new shared primaries to the same token, follows primary changes, and preserves overrides", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret();
    const primary = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    const override = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: false,
    });
    const { virtualKey, value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Automatic",
      authorId: owner.id,
      includeFutureProviders: true,
      providerApiKeys: [{ provider: "openai", providerApiKeyId: override.id }],
    });
    expect(await resolveVirtualKeyProviderMappings(virtualKey.id)).toEqual([
      expect.objectContaining({ providerApiKeyId: override.id }),
    ]);
    const later = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    expect(
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).map(
        (key) => key.providerApiKeyId,
      ),
    ).toEqual([override.id, later.id]);
    await LlmProviderApiKeyModel.update(later.id, { isPrimary: false });
    const replacement = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    expect(
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).map(
        (key) => key.providerApiKeyId,
      ),
    ).toEqual([override.id, replacement.id]);
    expect((await VirtualApiKeyModel.validateToken(value))?.virtualKey.id).toBe(
      virtualKey.id,
    );
    expect(
      (await resolveVirtualKeyProviderMappings(virtualKey.id)).some(
        (key) => key.providerApiKeyId === primary.id,
      ),
    ).toBe(false);
  });

  test("excludes other organizations, personal keys, subscription credentials, nonprimaries and unusable endpoints", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret();
    const subscription = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "test-refresh",
          accountId: "test-account",
        }),
      },
    });
    const shared = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(otherOrg.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      userId: owner.id,
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, subscription.id, {
      provider: "openai",
      userId: null,
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "groq",
      isPrimary: false,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      isPrimary: true,
    });
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Automatic",
      authorId: owner.id,
      includeFutureProviders: true,
      providerApiKeys: [],
    });
    expect(await resolveVirtualKeyProviderMappings(virtualKey.id)).toEqual([
      expect.objectContaining({ providerApiKeyId: shared.id }),
    ]);
    const fixed = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Selected",
      authorId: owner.id,
      providerApiKeys: [],
    });
    expect(
      await resolveVirtualKeyProviderMappings(fixed.virtualKey.id),
    ).toEqual([]);
  });
});
