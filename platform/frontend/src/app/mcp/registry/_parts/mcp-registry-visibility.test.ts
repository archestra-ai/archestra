import { describe, expect, it } from "vitest";
import {
  matchesMcpRegistryOwnershipFilters,
  mcpRegistryInstallPriority,
} from "./mcp-registry-visibility";

const item = (
  overrides: Partial<
    Parameters<typeof matchesMcpRegistryOwnershipFilters>[0]["item"]
  > = {},
) => ({
  id: "cat-1",
  scope: "personal" as const,
  authorId: "member-1",
  teams: [],
  ...overrides,
});

const install = (
  overrides: Partial<Parameters<typeof mcpRegistryInstallPriority>[0]> = {},
) => ({
  catalogId: "cat-1",
  scope: "personal" as const,
  ownerId: "member-1",
  teamId: null,
  ...overrides,
});

describe("MCP registry ownership visibility", () => {
  it("hides another user's personal-only row from the default admin list", () => {
    expect(
      matchesMcpRegistryOwnershipFilters({
        item: item(),
        servers: [install()],
        filters: { excludeOtherPersonal: true },
        currentUserId: "admin",
      }),
    ).toBe(false);
  });

  it("keeps a row reachable through the viewer's own team or organization install", () => {
    expect(
      matchesMcpRegistryOwnershipFilters({
        item: item({ scope: "team" }),
        servers: [
          install({ scope: "team", ownerId: "member-1", teamId: "team-a" }),
        ],
        filters: { excludeOtherPersonal: true },
        currentUserId: "admin",
      }),
    ).toBe(true);
  });

  it("exposes foreign personal rows only through Other users", () => {
    const args = {
      item: item(),
      servers: [install()],
      currentUserId: "admin",
    };
    expect(
      matchesMcpRegistryOwnershipFilters({
        ...args,
        filters: { scope: "personal", excludeAuthorIds: ["admin"] },
      }),
    ).toBe(true);
    expect(
      matchesMcpRegistryOwnershipFilters({
        ...args,
        filters: { scope: "personal", authorIds: ["admin"] },
      }),
    ).toBe(false);
  });

  it("matches team and organization scopes through either catalog or installation ownership", () => {
    expect(
      matchesMcpRegistryOwnershipFilters({
        item: item({ scope: "org" }),
        servers: [install({ scope: "team", teamId: "team-a" })],
        filters: { scope: "team", teamIds: ["team-a"] },
        currentUserId: "admin",
      }),
    ).toBe(true);
    expect(
      matchesMcpRegistryOwnershipFilters({
        item: item({ scope: "team" }),
        servers: [install({ scope: "org" })],
        filters: { scope: "org" },
        currentUserId: "admin",
      }),
    ).toBe(true);
  });

  it("prioritizes the viewer's own install before shared and foreign installs", () => {
    expect(
      mcpRegistryInstallPriority(install({ ownerId: "admin" }), "admin"),
    ).toBe(0);
    expect(
      mcpRegistryInstallPriority(install({ scope: "team" }), "admin"),
    ).toBe(1);
    expect(mcpRegistryInstallPriority(install({ scope: "org" }), "admin")).toBe(
      2,
    );
    expect(mcpRegistryInstallPriority(install(), "admin")).toBe(3);
  });
});
