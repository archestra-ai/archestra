import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMcpServerIssues } from "./use-mcp-server-issues";

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => ({ data: { user: { id: "user-1" } } }),
  useHasPermissions: () => ({ data: true }),
}));
vi.mock("@/lib/mcp/use-can-reauthenticate", () => ({
  useCanReauthenticate: () => () => true,
}));
vi.mock("@/lib/mcp/internal-mcp-catalog.query", () => ({
  useInternalMcpCatalog: () => ({
    data: [
      {
        id: "catalog-1",
        serverType: "remote",
        multitenant: false,
        catalogReinstallRequired: false,
        imageApprovalRequired: false,
        updatedAt: "2026-08-01T00:00:00.000Z",
        alertMutes: [],
      },
    ],
  }),
}));
vi.mock("@/lib/mcp/mcp-server.query", () => ({
  useMcpServers: () => ({
    data: [
      {
        id: "server-1",
        catalogId: "catalog-1",
        ownerId: "user-1",
        teamId: null,
        scope: "personal",
        localInstallationStatus: "success",
        localInstallationError: null,
        oauthRefreshError: "refresh_failed",
        oauthRefreshErrorMessage: null,
        oauthRefreshErrorDescription: null,
        oauthRefreshFailedAt: "2026-08-01T00:00:00.000Z",
        reinstallRequired: false,
        reinstallReason: null,
        updatedAt: "2026-08-01T00:00:00.000Z",
        alertMutes: [],
      },
    ],
  }),
}));

describe("useMcpServerIssues", () => {
  it("derives alerts and counts from the server error payloads", () => {
    const { result } = renderHook(() => useMcpServerIssues({}));
    expect(result.current.issuesByCatalog.get("catalog-1")).toEqual([
      expect.objectContaining({ kind: "needs-reauth" }),
    ]);
    expect(result.current.facetCounts.you).toBe(1);
  });
});
