import { beforeEach, describe, expect, test, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  llm: {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      workloadIdentity: {
        enabled: true,
        tokenUrl: "",
        federationRuleId: "fdrl_test",
        organizationId: "00000000-0000-0000-0000-000000000000",
        serviceAccountId: "svac_test",
        workspaceId: "wrkspc_test",
        identityToken: "idp-jwt",
        identityTokenFile: "",
      },
    },
  },
}));

vi.mock("@/config", () => ({
  default: mockConfig,
}));

import {
  __test,
  createAnthropicWorkloadIdentityFetch,
  isAnthropicWorkloadIdentityEnabled,
} from "./anthropic-workload-identity";

describe("anthropic workload identity", () => {
  beforeEach(() => {
    __test.resetTokenCache();
    mockConfig.llm.anthropic.workloadIdentity.enabled = true;
    mockConfig.llm.anthropic.workloadIdentity.federationRuleId = "fdrl_test";
    mockConfig.llm.anthropic.workloadIdentity.organizationId =
      "00000000-0000-0000-0000-000000000000";
    mockConfig.llm.anthropic.workloadIdentity.serviceAccountId = "svac_test";
    mockConfig.llm.anthropic.workloadIdentity.workspaceId = "wrkspc_test";
    mockConfig.llm.anthropic.workloadIdentity.identityToken = "idp-jwt";
    mockConfig.llm.anthropic.workloadIdentity.identityTokenFile = "";
  });

  test("requires enabled workload identity config and an identity token source", () => {
    expect(isAnthropicWorkloadIdentityEnabled()).toBe(true);

    mockConfig.llm.anthropic.workloadIdentity.identityToken = "";
    expect(isAnthropicWorkloadIdentityEnabled()).toBe(false);

    mockConfig.llm.anthropic.workloadIdentity.identityTokenFile =
      "/var/run/secrets/anthropic.com/token";
    expect(isAnthropicWorkloadIdentityEnabled()).toBe(true);
  });

  test("exchanges the identity token and injects bearer auth", async () => {
    const fetchMock = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        _init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        if (String(input).endsWith("/v1/oauth/token")) {
          return new Response(
            JSON.stringify({
              access_token: "anthropic-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response("{}", { status: 200 });
      },
    );

    const wrappedFetch = createAnthropicWorkloadIdentityFetch(
      fetchMock as unknown as typeof globalThis.fetch,
    );
    await wrappedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": "ARCHESTRA_ANTHROPIC_WIF_KEYLESS",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(tokenRequest.body as string)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "idp-jwt",
      federation_rule_id: "fdrl_test",
      organization_id: "00000000-0000-0000-0000-000000000000",
      service_account_id: "svac_test",
      workspace_id: "wrkspc_test",
    });

    const providerRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = new Headers(providerRequest.headers);
    expect(headers.get("authorization")).toBe("Bearer anthropic-access-token");
    expect(headers.has("x-api-key")).toBe(false);
  });
});
