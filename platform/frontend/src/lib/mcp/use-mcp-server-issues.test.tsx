import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpServerIssues } from "./use-mcp-server-issues";

const { useFeatureMock } = vi.hoisted(() => ({ useFeatureMock: vi.fn() }));

vi.mock("@/lib/config/config.query", () => ({ useFeature: useFeatureMock }));
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

describe("useMcpServerIssues beta gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns no alerts or counts while the deployment flag is off", () => {
    useFeatureMock.mockReturnValue(false);
    const { result } = renderHook(() => useMcpServerIssues({}));
    expect(result.current.issuesByCatalog.size).toBe(0);
    expect(result.current.facetCounts).toEqual({
      you: 0,
      others: 0,
      muted: 0,
    });
  });

  it("derives alerts when the deployment flag is on", () => {
    useFeatureMock.mockReturnValue(true);
    const { result } = renderHook(() => useMcpServerIssues({}));
    expect(result.current.issuesByCatalog.get("catalog-1")).toEqual([
      expect.objectContaining({ kind: "needs-reauth" }),
    ]);
    expect(result.current.facetCounts.you).toBe(1);
  });
});
