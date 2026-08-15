import { ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { encodeOpenAiCodexCredential } from "./openai-codex-credentials";
import { assertSubscriptionCredentialForProvider } from "./subscription-credential-guard";
import { encodeXaiSubscriptionCredential } from "./xai-subscription-credentials";

describe("assertSubscriptionCredentialForProvider", () => {
  const xaiCredential = encodeXaiSubscriptionCredential({
    refreshToken: "rt-xai",
    userId: "x-user",
  });
  const chatgptCredential = encodeOpenAiCodexCredential({
    refreshToken: "rt-openai",
    accountId: "acct-openai",
  });

  test("accepts valid credentials only for their owning provider", () => {
    expect(() =>
      assertSubscriptionCredentialForProvider({
        apiKey: `Bearer ${xaiCredential}`,
        provider: "xai",
      }),
    ).not.toThrow();
    expect(() =>
      assertSubscriptionCredentialForProvider({
        apiKey: chatgptCredential,
        provider: "openai",
      }),
    ).not.toThrow();
  });

  test.each([
    [xaiCredential, "openai" as const],
    [chatgptCredential, "xai" as const],
    ["xai-subscription:not-json", "xai" as const],
    ["chatgpt-oauth:not-json", "openai" as const],
  ])("rejects a foreign or malformed marker before use", (apiKey, provider) => {
    let thrown: unknown;
    try {
      assertSubscriptionCredentialForProvider({ apiKey, provider });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      statusCode: 401,
      internalCode: ArchestraInternalErrorCode.ProviderAuthRequired,
    });
  });
});
