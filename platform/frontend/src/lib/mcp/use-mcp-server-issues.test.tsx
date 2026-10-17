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
vi.mock("@/lib/mcp/mcp-registry.query", () => ({
  useMcpRegistryIssueIndex: () => ({
    data: {
      catalogItems: [
        {
          id: "catalog-1",
          name: "catalog",
          serverType: "remote",
          multitenant: false,
          dynamicConnectionMcpServerId: null,
          environmentId: null,
          authorId: null,
          authorName: null,
          alertMutes: [],
        },
      ],
      servers: [
        {
          id: "server-1",
          catalogId: "catalog-1",
          ownerId: "user-1",
          teamId: null,
          scope: "personal",
          canUseCredential: true,
          localInstallationStatus: "success",
          localInstallationError: null,
          oauthRefreshError: "refresh_failed",
          oauthRefreshErrorMessage: null,
          oauthRefreshErrorDescription: null,
          oauthRefreshFailedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          alertMutes: [],
        },
      ],
    },
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
