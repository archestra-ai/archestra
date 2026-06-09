import { LINKED_IDP_SSO_MODE } from "@archestra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingEnterpriseManagedInstall,
  consumePendingEnterpriseManagedInstall,
  getEnterpriseManagedInstallConnectUrl,
  getPendingEnterpriseManagedInstall,
  setPendingEnterpriseManagedInstall,
} from "./enterprise-managed-install-auth";

describe("enterprise-managed MCP install auth", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns no connect URL when the configured identity provider is linked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          providerId: "EntraID",
          connected: true,
        }),
        { status: 200 },
      ),
    );

    await expect(
      getEnterpriseManagedInstallConnectUrl({
        catalogItem: catalogItem("idp-123"),
        redirectTo: "/mcp/registry",
      }),
    ).resolves.toBeNull();
  });

  it("builds a linked identity-provider URL when the configured provider is not linked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          providerId: "EntraID",
          connected: false,
        }),
        { status: 200 },
      ),
    );

    await expect(
      getEnterpriseManagedInstallConnectUrl({
        catalogItem: catalogItem("idp-123"),
        redirectTo: "/mcp/registry",
      }),
    ).resolves.toBe(
      `/auth/sso/EntraID?redirectTo=%2Fmcp%2Fregistry&mode=${LINKED_IDP_SSO_MODE}`,
    );
  });

  it("stores install intents as one-shot state", () => {
    setPendingEnterpriseManagedInstall({
      action: "direct",
      catalogId: "catalog-123",
      scope: "team",
      teamId: "team-123",
    });

    expect(consumePendingEnterpriseManagedInstall()).toEqual({
      action: "direct",
      catalogId: "catalog-123",
      scope: "team",
      teamId: "team-123",
    });
    expect(consumePendingEnterpriseManagedInstall()).toBeNull();
  });

  it("keeps install intents pending until they are explicitly cleared", () => {
    setPendingEnterpriseManagedInstall({
      action: "open-remote",
      catalogId: "catalog-123",
      scope: "org",
    });

    expect(getPendingEnterpriseManagedInstall()).toEqual({
      action: "open-remote",
      catalogId: "catalog-123",
      scope: "org",
    });
    expect(getPendingEnterpriseManagedInstall()).toEqual({
      action: "open-remote",
      catalogId: "catalog-123",
      scope: "org",
    });

    clearPendingEnterpriseManagedInstall();
    expect(getPendingEnterpriseManagedInstall()).toBeNull();
  });
});

function catalogItem(identityProviderId: string) {
  return {
    id: "catalog-123",
    enterpriseManagedConfig: {
      identityProviderId,
    },
  } as Parameters<
    typeof getEnterpriseManagedInstallConnectUrl
  >[0]["catalogItem"];
}
