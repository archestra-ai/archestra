import type { Permissions } from "@archestra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverCanAccessPage, serverHasPermissions } from "./auth.server";

const { getUserPermissionsMock, getServerApiHeadersMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  getServerApiHeadersMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getUserPermissions: getUserPermissionsMock,
    },
  };
});

vi.mock("@archestra/shared/access-control", () => ({
  requiredPagePermissionsMap: {
    "/mcp/gateways": {
      mcpGateway: ["read"],
    },
  },
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: getServerApiHeadersMock,
}));

describe("serverHasPermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerApiHeadersMock.mockResolvedValue({ Cookie: "session=abc" });
  });

  it("returns true when the server-fetched permissions satisfy the requirement", async () => {
    const permissions: Permissions = {
      mcpGateway: ["read"],
    };

    getUserPermissionsMock.mockResolvedValue({
      data: permissions,
    });

    await expect(serverHasPermissions(permissions)).resolves.toBe(true);
    expect(getUserPermissionsMock).toHaveBeenCalledWith({
      headers: { Cookie: "session=abc" },
    });
  });

  it("returns false when the server-fetched permissions do not satisfy the requirement", async () => {
    getUserPermissionsMock.mockResolvedValue({
      data: {},
    });

    await expect(
      serverHasPermissions({
        team: ["read"],
      }),
    ).resolves.toBe(false);
  });

  // The SDK is configured with `throwOnError: false`, so a lookup that never
  // reached the backend resolves with an error and no response. Reading that as
  // "no permissions" renders a 403 for what is really an outage.
  it("throws instead of denying when the lookup never got a response", async () => {
    getUserPermissionsMock.mockResolvedValue({
      error: new TypeError("fetch failed"),
      response: undefined,
    });

    await expect(serverHasPermissions({ team: ["read"] })).rejects.toThrow(
      /Permission lookup failed/,
    );
  });

  it("throws instead of denying when the lookup fails server-side", async () => {
    getUserPermissionsMock.mockResolvedValue({
      error: { message: "boom" },
      response: { status: 503 },
    });

    await expect(serverHasPermissions({ team: ["read"] })).rejects.toThrow(
      /Permission lookup failed/,
    );
  });

  // A 4xx is the backend answering the authorization question, not failing to.
  it("denies without throwing when the lookup is rejected client-side", async () => {
    getUserPermissionsMock.mockResolvedValue({
      error: { message: "forbidden" },
      response: { status: 403 },
    });

    await expect(serverHasPermissions({ team: ["read"] })).resolves.toBe(false);
  });
});

describe("serverCanAccessPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerApiHeadersMock.mockResolvedValue({ Cookie: "session=abc" });
  });

  it("uses requiredPagePermissionsMap for the given page", async () => {
    getUserPermissionsMock.mockResolvedValue({
      data: {
        mcpGateway: ["read"],
      } satisfies Permissions,
    });

    await expect(serverCanAccessPage("/mcp/gateways")).resolves.toBe(true);
  });

  it("allows pages with no configured requirements", async () => {
    getUserPermissionsMock.mockResolvedValue({
      data: {},
    });

    await expect(serverCanAccessPage("/unknown-page")).resolves.toBe(true);
  });
});
