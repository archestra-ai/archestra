import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { decodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/cache-manager");

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    llm: {
      openai: {
        codex: {
          issuer: "https://auth.openai.com",
          clientId: "app_test_client",
          originator: "codex_cli_rs",
          apiBaseUrl: "https://chatgpt.com/backend-api/codex",
        },
      },
    },
  }),
);

/** JWT whose namespaced auth claim carries the ChatGPT account id. */
function idTokenWithAccount(accountId: string): string {
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.sig`;
}

describe("POST /api/openai-codex-auth/device/poll", () => {
  let app: FastifyInstanceWithZod;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organization.id;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: openaiCodexAuthRoutes } = await import(
      "./openai-codex-auth.routes"
    );
    await app.register(openaiCodexAuthRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  test("returns pending while the user has not authorized yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 403 })),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/openai-codex-auth/device/poll",
      payload: { deviceAuthId: "dev-auth-1", userCode: "WXYZ-9876" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
  });

  test("exchanges the authorization code and returns an encoded credential", async () => {
    const fetchMock = vi
      .fn()
      // 1) deviceauth/token → authorization code + verifier
      .mockResolvedValueOnce(
        Response.json({
          authorization_code: "auth-code-1",
          code_verifier: "verifier-1",
        }),
      )
      // 2) oauth/token → tokens
      .mockResolvedValueOnce(
        Response.json({
          access_token: "at_1",
          refresh_token: "rt_1",
          id_token: idTokenWithAccount("acc_xyz"),
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.inject({
      method: "POST",
      url: "/api/openai-codex-auth/device/poll",
      payload: { deviceAuthId: "dev-auth-1", userCode: "WXYZ-9876" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("complete");
    expect(decodeOpenAiCodexCredential(body.credential)).toEqual({
      refreshToken: "rt_1",
      accountId: "acc_xyz",
    });

    // First call polls deviceauth/token with { device_auth_id, user_code } —
    // and no client_id, matching the Codex CLI's poll request.
    const [pollUrl, pollInit] = fetchMock.mock.calls[0];
    expect(String(pollUrl)).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/token",
    );
    expect(JSON.parse(pollInit.body as string)).toEqual({
      device_auth_id: "dev-auth-1",
      user_code: "WXYZ-9876",
    });

    // Second call is the token exchange with the returned code + verifier.
    const [exchangeUrl, exchangeInit] = fetchMock.mock.calls[1];
    expect(String(exchangeUrl)).toBe("https://auth.openai.com/oauth/token");
    const exchangeBody = exchangeInit.body as URLSearchParams;
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("code")).toBe("auth-code-1");
    expect(exchangeBody.get("code_verifier")).toBe("verifier-1");
  });
});
