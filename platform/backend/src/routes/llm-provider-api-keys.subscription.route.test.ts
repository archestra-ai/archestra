import { assert, vi } from "vitest";
import config from "@/config";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import { secretManager } from "@/secrets-manager";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
} from "@/services/xai-subscription-credentials";
import { XaiSubscriptionTokenManager } from "@/services/xai-subscription-token";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import llmProviderApiKeyRoutes from "./llm-provider-api-keys";

describe("SuperGrok validation credential persistence", () => {
  const context = useRouteTestApp(llmProviderApiKeyRoutes);
  const credential = {
    refreshToken: "rt_device",
    userId: "test-account",
    email: "account@example.com",
  };
  let redemptions: string[];

  beforeEach(async ({ makeMember }) => {
    credential.refreshToken = `rt_device_${crypto.randomUUID()}`;
    await makeMember(context.user.id, context.organizationId, {
      role: "admin",
    });
    registerAuditLogHook(context.app);
    redemptions = [];
    config.llm.xai.subscription.issuer = "https://auth.x.ai";
    config.llm.xai.subscription.baseUrl = "https://cli-chat-proxy.grok.test/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/.well-known/openid-configuration")) {
          return Response.json({
            device_authorization_endpoint:
              "https://auth.x.ai/oauth2/device/code",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          });
        }
        if (url === "https://auth.x.ai/oauth2/token") {
          const refreshToken =
            new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
          redemptions.push(refreshToken);
          if (
            refreshToken !== credential.refreshToken ||
            redemptions.length > 1
          ) {
            return Response.json(
              {
                error: "invalid_grant",
                error_description: "Refresh token has been revoked",
              },
              { status: 400 },
            );
          }
          return Response.json({
            access_token: "at_validation",
            refresh_token: "rt_rotated",
            expires_in: 3600,
          });
        }
        if (url.endsWith("/models"))
          return Response.json({
            data: [
              {
                id: "grok-test",
                object: "model",
                supported_endpoints: ["chat/completions"],
              },
            ],
          });
        if (url === "https://models.dev/api.json") return Response.json({});
        throw new Error(`Unexpected test fetch: ${url}`);
      }),
    );
  });

  for (const operation of ["create", "reconnect"] as const) {
    test(`${operation} stores the validation access token so the first proxy request does not redeem`, async ({
      makeLlmProviderApiKey,
      makeSecret,
    }) => {
      let keyId: string | undefined;
      if (operation === "reconnect") {
        const secret = await makeSecret({
          secret: {
            apiKey: encodeXaiSubscriptionCredential({
              ...credential,
              refreshToken: "rt_dead",
            }),
          },
        });
        const key = await makeLlmProviderApiKey(
          context.organizationId,
          secret.id,
          { provider: "xai", userId: context.user.id },
        );
        keyId = key.id;
        await LlmProviderApiKeyModel.setRequiresReauthentication({
          id: keyId,
          requiresReauthentication: true,
        });
      }
      const response = await context.app.inject({
        method: "POST",
        url:
          operation === "create"
            ? "/api/llm-provider-api-keys"
            : `/api/llm-provider-api-keys/${keyId}/reconnect`,
        payload:
          operation === "create"
            ? {
                name: "SuperGrok test",
                provider: "xai",
                apiKey: encodeXaiSubscriptionCredential(credential),
              }
            : { apiKey: encodeXaiSubscriptionCredential(credential) },
      });
      expect(response.statusCode, response.body).toBe(200);
      const row = await LlmProviderApiKeyModel.findById(response.json().id);
      expect(row?.requiresReauthentication).toBe(false);
      assert(row?.secretId);
      const secret = await secretManager().getSecret(row.secretId, {
        skipCache: true,
      });
      const stored = decodeXaiSubscriptionCredential(
        secret?.secret.apiKey as string,
      );
      assert(stored);
      expect(stored).toMatchObject({
        ...credential,
        refreshToken: "rt_rotated",
        accessToken: "at_validation",
        accessTokenExpiresAtMs: expect.any(Number),
      });
      expect(
        await new XaiSubscriptionTokenManager().getAccessToken({
          credential: stored,
          providerApiKeyId: row.id,
        }),
      ).toBe("at_validation");
      expect(redemptions).toEqual([credential.refreshToken]);
      await vi.waitFor(async () => {
        const { data: audits } = await AuditLogModel.findPaginated({
          organizationId: context.organizationId,
          resourceType: "llmProviderApiKey",
          limit: 50,
          offset: 0,
        });
        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe(
          operation === "create"
            ? "llmProviderApiKey.created"
            : "llmProviderApiKey.updated",
        );
        if (operation === "reconnect") {
          expect(audits[0].before).toMatchObject({
            requiresReauthentication: true,
          });
          expect(audits[0].after).toMatchObject({
            requiresReauthentication: false,
          });
        }
        expect(JSON.stringify(audits)).not.toContain("rt_device");
        expect(JSON.stringify(audits)).not.toContain("at_validation");
      });
    });
  }
});
