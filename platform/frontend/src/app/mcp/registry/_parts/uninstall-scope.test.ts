// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  agentsLosingAccessOnUninstall,
  isOwnPersonalInstall,
} from "./uninstall-scope";

const ME = "user-me";

describe("isOwnPersonalInstall", () => {
  it("offers the viewer's own personal connection", () => {
    expect(
      isOwnPersonalInstall(
        { ownerId: ME, teamId: null, scope: "personal" },
        ME,
      ),
    ).toBe(true);
  });

  it("does not treat an org-wide install the viewer created as their own", () => {
    // Org installs carry no team id and record their installer as owner, so
    // an owner-and-no-team check mistook them for the viewer's connection.
    expect(
      isOwnPersonalInstall({ ownerId: ME, teamId: null, scope: "org" }, ME),
    ).toBe(false);
  });

  it("does not treat a team install the viewer created as their own", () => {
    expect(
      isOwnPersonalInstall(
        { ownerId: ME, teamId: "team-1", scope: "team" },
        ME,
      ),
    ).toBe(false);
  });

  it("does not offer another user's personal connection, or any while signed out", () => {
    const othersInstall = {
      ownerId: "someone-else",
      teamId: null,
      scope: "personal" as const,
    };
    expect(isOwnPersonalInstall(othersInstall, ME)).toBe(false);
    expect(
      isOwnPersonalInstall({ ...othersInstall, ownerId: ME }, undefined),
    ).toBe(false);
  });
});

describe("agentsLosingAccessOnUninstall", () => {
  const pinnedGateway = { id: "a-pinned", pinned: true };
  const orgAgent = { id: "a-org", pinned: false };
  const assignedAgents = [pinnedGateway, orgAgent];

  it("counts only agents pinned to a personal connection", () => {
    // Unpinned agents resolve per caller; other users never resolve to this
    // connection, so they keep their access.
    expect(
      agentsLosingAccessOnUninstall({
        server: { scope: "personal", teamId: null },
        assignedAgents,
      }),
    ).toEqual([pinnedGateway]);
  });

  it("counts every assigned agent for a shared connection", () => {
    for (const server of [
      { scope: "org" as const, teamId: null },
      { scope: "team" as const, teamId: "team-1" },
    ]) {
      expect(agentsLosingAccessOnUninstall({ server, assignedAgents })).toEqual(
        assignedAgents,
      );
    }
  });
});
