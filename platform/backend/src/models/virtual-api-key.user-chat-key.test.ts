import { describe } from "vitest";
import { expect, test } from "@/test";
import VirtualApiKeyModel from "./virtual-api-key";

describe("VirtualApiKeyModel.ensureUserChatKey", () => {
  test("creates a personal key on first use that the proxy resolves", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

    const { virtualKeyId, value } = await VirtualApiKeyModel.ensureUserChatKey({
      organizationId: org.id,
      userId: user.id,
      provider: chatApiKey.provider,
      providerApiKeyId: chatApiKey.id,
    });

    const resolved = await VirtualApiKeyModel.validateToken(value);
    const virtualKey = resolved?.virtualKey;
    expect(virtualKey?.id).toBe(virtualKeyId);
    expect(virtualKey?.authorId).toBe(user.id);
    expect(
      virtualKey && (await VirtualApiKeyModel.isPersonal(virtualKey)),
    ).toBe(true);
  });

  test("reuses the same key and token on later calls", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-real-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);
    const input = {
      organizationId: org.id,
      userId: user.id,
      provider: chatApiKey.provider,
      providerApiKeyId: chatApiKey.id,
    };

    const first = await VirtualApiKeyModel.ensureUserChatKey(input);
    const second = await VirtualApiKeyModel.ensureUserChatKey(input);

    expect(second.virtualKeyId).toBe(first.virtualKeyId);
    expect(second.value).toBe(first.value);
  });
});
