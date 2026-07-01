import type { archestraApiTypes } from "@archestra/shared";

type InstalledServer = archestraApiTypes.GetMcpServersResponses["200"][number];

/** Installed MCP server in `success` state; override `localInstallationStatus` for error UI. */
export function makeInstalledServer(
  overrides: Partial<InstalledServer> = {},
): InstalledServer {
  return {
    id: "test-server",
    name: "test-server",
    catalogId: "test-catalog",
    serverType: "local",
    secretId: null,
    environmentValues: null,
    ownerId: "test-user-admin",
    teamId: null,
    scope: "personal",
    reinstallRequired: false,
    localInstallationStatus: "success",
    localInstallationError: null,
    oauthRefreshError: "refresh_failed",
    oauthRefreshErrorMessage: "invalid_grant",
    oauthRefreshFailedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export const installedServersSeed: archestraApiTypes.GetMcpServersResponses["200"] =
  [
    makeInstalledServer({
      id: "test-server-filesystem",
      name: "filesystem",
      catalogId: "test-catalog-filesystem",
    }),
  ];
