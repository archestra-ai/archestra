import type { Permissions } from "@shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverCanAccessPage, serverHasPermissions } from "./auth.server";

const { getUserPermissionsMock, getServerApiHeadersMock } = vi.hoisted(() => ({
  getUserPermissionsMock: vi.fn(),
  getServerApiHeadersMock: vi.fn(),
}));

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getUserPermissions: getUserPermissionsMock,
  },
}));

vi.mock("@shared/access-control", () => ({
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
