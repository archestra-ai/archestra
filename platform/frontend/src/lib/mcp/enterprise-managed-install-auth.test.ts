import { archestraApiSdk, LINKED_IDP_SSO_MODE } from "@archestra/shared";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingEnterpriseManagedInstall,
  getPendingEnterpriseManagedInstall,
  setPendingEnterpriseManagedInstall,
  useEnterpriseManagedInstallConnectUrl,
} from "./enterprise-managed-install-auth";

describe("enterprise-managed MCP install auth", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns no connect URL when the configured identity provider is linked", async () => {
    mockLinkStatus({ providerId: "EntraID", connected: true });
    const { result } = renderHook(() =>
      useEnterpriseManagedInstallConnectUrl(),
    );

    await expect(
      result.current({
        catalogItem: catalogItem("idp-123"),
        redirectTo: "/mcp/registry",
      }),
    ).resolves.toBeNull();
  });

  it("builds a linked identity-provider URL when the configured provider is not linked", async () => {
    mockLinkStatus({ providerId: "EntraID", connected: false });
    const { result } = renderHook(() =>
      useEnterpriseManagedInstallConnectUrl(),
    );

    await expect(
      result.current({
        catalogItem: catalogItem("idp-123"),
        redirectTo: "/mcp/registry",
      }),
    ).resolves.toBe(
      `/auth/sso/EntraID?redirectTo=%2Fmcp%2Fregistry&mode=${LINKED_IDP_SSO_MODE}`,
    );
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
    enterpriseManagedConfig: {
      identityProviderId,
    },
  } as Parameters<
    ReturnType<typeof useEnterpriseManagedInstallConnectUrl>
  >[0]["catalogItem"];
}

function mockLinkStatus(data: { providerId: string; connected: boolean }) {
  const response = {
    data,
    error: undefined,
  } as Awaited<
    ReturnType<typeof archestraApiSdk.getIdentityProviderLinkStatus>
  >;

  vi.spyOn(
    archestraApiSdk,
    "getIdentityProviderLinkStatus",
  ).mockResolvedValueOnce(response);
}
