import { randomUUID } from "node:crypto";
import config from "@/config";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { secretManager } from "@/secrets-manager";
import { afterEach, expect, test, vi } from "@/test";
import { createGithubCopilotFetch } from "./github-copilot-token";
import { createMicrosoft365CopilotFetch } from "./microsoft-365-copilot-token";
import { encodeXaiSubscriptionCredential } from "./xai-subscription-credentials";
import { createXaiSubscriptionFetch } from "./xai-subscription-token";

const originalIssuer = config.llm.xai.subscription.issuer;
afterEach(() => {
  config.llm.xai.subscription.issuer = originalIssuer;
});

for (const provider of [
  "github-copilot",
  "xai",
  "microsoft-365-copilot",
] as const) {
  for (const scenario of [
    "rejected",
    "transient",
    "reconnected",
    "retry-rejected",
    "retry-recovered",
    "retry-transient",
    "retry-refresh-rejected",
  ] as const) {
    test(`${provider} inference status: ${scenario}`, async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const organization = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, organization.id);
      const token = randomUUID();
      const credential = { refreshToken: token, userId: "fixture-account" };
      const encode = (value: string) =>
        provider === "xai"
          ? encodeXaiSubscriptionCredential({
              ...credential,
              refreshToken: value,
            })
          : value;
      const secret = await secretManager().createSecret(
        { apiKey: encode(token) },
        `subscription-${randomUUID()}`,
      );
      const key = await LlmProviderApiKeyModel.create({
        organizationId: organization.id,
        name: "Fixture subscription",
        provider,
        secretId: secret.id,
        scope: "personal",
        userId: user.id,
      });
      const issuer = `https://auth.${randomUUID()}.test`;
      config.llm.xai.subscription.issuer = issuer;
      let exchanges = 0;
      const oauth = vi.fn(async (input: unknown) => {
        if (String(input).includes(".well-known"))
          return Response.json({
            token_endpoint: `${issuer}/token`,
            device_authorization_endpoint: `${issuer}/device`,
          });
        exchanges++;
        if (scenario === "reconnected") {
          await secretManager().updateSecret(secret.id, {
            apiKey: encode("replacement-family"),
          });
          await LlmProviderApiKeyModel.update(key.id, { secretId: secret.id });
        }
        if (
          !scenario.startsWith("retry-") ||
          (scenario === "retry-refresh-rejected" && exchanges > 1)
        ) {
          return Response.json(
            { error: "invalid_grant" },
            { status: scenario === "transient" ? 503 : 401 },
          );
        }
        return Response.json(
          provider === "github-copilot"
            ? {
                token: `bearer-${exchanges}`,
                expires_at: Math.floor(Date.now() / 1000) + 3600,
                endpoints: { api: "https://api.githubcopilot.com" },
              }
            : {
                access_token: `access-${exchanges}`,
                expires_in: 3600,
                refresh_token: `rotated-${token}-${exchanges}`,
              },
        );
      });
      vi.stubGlobal("fetch", oauth);
      const finalStatus =
        scenario === "retry-recovered"
          ? 200
          : scenario === "retry-transient"
            ? 503
            : 401;
      const upstream = vi
        .fn()
        .mockResolvedValueOnce(Response.json({}, { status: 401 }))
        .mockImplementation(async () =>
          Response.json({}, { status: finalStatus }),
        );
      const request =
        provider === "github-copilot"
          ? createGithubCopilotFetch({
              githubToken: token,
              providerApiKeyId: key.id,
              innerFetch: upstream,
            })
          : provider === "xai"
            ? createXaiSubscriptionFetch({
                credential,
                providerApiKeyId: key.id,
                innerFetch: upstream,
              })
            : createMicrosoft365CopilotFetch({
                refreshToken: token,
                providerApiKeyId: key.id,
                innerFetch: upstream,
              });
      const url =
        provider === "xai"
          ? `${config.llm.xai.subscription.baseUrl}/chat/completions`
          : "https://api.githubcopilot.com/chat/completions";
      const response = await request(url, {
        method: "POST",
        body: JSON.stringify({ model: "fixture-model", messages: [] }),
      });
      const expectedStatus =
        scenario === "transient"
          ? 502
          : scenario.startsWith("retry-")
            ? finalStatus
            : 401;
      expect(response.status).toBe(expectedStatus);
      expect(upstream).toHaveBeenCalledTimes(
        scenario === "retry-refresh-rejected"
          ? 1
          : scenario.startsWith("retry-")
            ? 2
            : 0,
      );
      const expected = [
        "rejected",
        "retry-rejected",
        "retry-refresh-rejected",
      ].includes(scenario);
      expect(
        (await LlmProviderApiKeyModel.findById(key.id))
          ?.requiresReauthentication,
      ).toBe(expected);
      const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        organization.id,
        user.id,
        [],
        provider,
        { includeSubscriptionInfo: true },
      );
      expect(
        available.find((row) => row.id === key.id)?.requiresReauthentication,
      ).toBe(expected);
    });
  }
}
