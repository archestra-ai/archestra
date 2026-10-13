// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isMcpServerInstalledForViewer,
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

// Defaults to another member's personal connection, which an admin's listing
// returns but the admin cannot use.
const install = (
  overrides: Partial<Parameters<typeof mcpRegistryInstallPriority>[0]> = {},
) => ({
  catalogId: "cat-1",
  scope: "personal" as const,
  ownerId: "member-1",
  teamId: null,
  canUseCredential: false,
  ...overrides,
});

describe("isMcpServerInstalledForViewer", () => {
  it("is installed through the viewer's own personal connection", () => {
    expect(
      isMcpServerInstalledForViewer([
        install({ ownerId: "viewer", canUseCredential: true }),
      ]),
    ).toBe(true);
  });

  it("is installed through a team or organization connection shared with the viewer", () => {
    expect(
      isMcpServerInstalledForViewer([
        install({ scope: "team", teamId: "team-a", canUseCredential: true }),
      ]),
    ).toBe(true);
    expect(
      isMcpServerInstalledForViewer([
        install({ scope: "org", canUseCredential: true }),
      ]),
    ).toBe(true);
  });

  it("is not installed when only connections the viewer cannot use exist", () => {
    // An admin sees a colleague's personal connection and another team's
    // connection; neither lets the admin use the server.
    expect(
      isMcpServerInstalledForViewer([
        install(),
        install({ scope: "team", teamId: "team-b" }),
      ]),
    ).toBe(false);
  });

  it("is not installed for a multi-tenant server a colleague connected to", () => {
    // Multi-tenant installs alias one pod but stay per-member rows.
    expect(
      isMcpServerInstalledForViewer([install({ ownerId: "colleague" })]),
    ).toBe(false);
  });

  it("is not installed without any connection", () => {
    expect(isMcpServerInstalledForViewer([])).toBe(false);
  });
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
          install({
            scope: "team",
            ownerId: "member-1",
            teamId: "team-a",
            canUseCredential: true,
          }),
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
      mcpRegistryInstallPriority(
        install({ ownerId: "admin", canUseCredential: true }),
        "admin",
      ),
    ).toBe(0);
    expect(
      mcpRegistryInstallPriority(
        install({ scope: "team", canUseCredential: true }),
        "admin",
      ),
    ).toBe(1);
    expect(
      mcpRegistryInstallPriority(
        install({ scope: "org", canUseCredential: true }),
        "admin",
      ),
    ).toBe(2);
    expect(mcpRegistryInstallPriority(install(), "admin")).toBe(3);
  });

  it("never lets a connection the viewer cannot use represent the server", () => {
    // Another team's connection, visible to an admin outside that team.
    expect(
      mcpRegistryInstallPriority(install({ scope: "team" }), "admin"),
    ).toBe(3);
  });
});
