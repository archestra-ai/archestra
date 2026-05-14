import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockConfig, mockReadFile } = vi.hoisted(() => ({
  mockConfig: {
    llm: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        workloadIdentity: {
          enabled: true,
          federationRuleId: "fdrl_test",
          organizationId: "00000000-0000-0000-0000-000000000000",
          serviceAccountId: "svac_test",
          workspaceId: "wrkspc_test",
          identityTokenFile: "",
          identityToken: "oidc-token",
        },
      },
    },
  },
  mockReadFile: vi.fn(),
}));

vi.mock("@/config", () => ({
  default: mockConfig,
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

import {
  getAnthropicWorkloadIdentityBearerTokenProvider,
  isAnthropicWorkloadIdentityEnabled,
} from "./anthropic-workload-identity";

describe("anthropic-workload-identity", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    Object.assign(mockConfig.llm.anthropic.workloadIdentity, {
      enabled: true,
      federationRuleId: "fdrl_test",
      organizationId: "00000000-0000-0000-0000-000000000000",
      serviceAccountId: "svac_test",
      workspaceId: "wrkspc_test",
      identityTokenFile: "",
      identityToken: "oidc-token",
    });
  });

  test("reports enabled when the required Archestra-prefixed env config exists", () => {
    expect(isAnthropicWorkloadIdentityEnabled()).toBe(true);
  });

  test("exchanges an identity token for a cached Anthropic bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-test",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    const provider = getAnthropicWorkloadIdentityBearerTokenProvider(
      "https://api.anthropic.com",
      fetchMock,
    );

    await expect(provider()).resolves.toBe("sk-ant-oat01-test");
    await expect(provider()).resolves.toBe("sk-ant-oat01-test");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );

    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, string>;
    expect(body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "oidc-token",
      federation_rule_id: "fdrl_test",
      organization_id: "00000000-0000-0000-0000-000000000000",
      service_account_id: "svac_test",
      workspace_id: "wrkspc_test",
    });
  });

  test("reads the identity token file when configured", async () => {
    mockConfig.llm.anthropic.workloadIdentity.identityToken = "";
    mockConfig.llm.anthropic.workloadIdentity.identityTokenFile =
      "/var/run/secrets/anthropic.com/token";
    mockReadFile.mockResolvedValue("file-oidc-token\n");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-file",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    await expect(
      getAnthropicWorkloadIdentityBearerTokenProvider(
        "https://api.anthropic.com",
        fetchMock,
      )(),
    ).resolves.toBe("sk-ant-oat01-file");

    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, string>;
    expect(body.assertion).toBe("file-oidc-token");
  });

  test("reports disabled when identity token source is missing", () => {
    mockConfig.llm.anthropic.workloadIdentity.identityToken = "";
    mockConfig.llm.anthropic.workloadIdentity.identityTokenFile = "";

    expect(isAnthropicWorkloadIdentityEnabled()).toBe(false);
  });
});
