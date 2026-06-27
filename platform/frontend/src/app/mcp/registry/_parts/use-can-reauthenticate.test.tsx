import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSession = vi.fn();
const mockMyTeams = vi.fn();
const mockHasPermissions = vi.fn();

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: () => mockSession(),
  useHasPermissions: (perm: { mcpServerInstallation?: string[] }) =>
    mockHasPermissions(perm),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useMyTeams: () => mockMyTeams(),
}));

import { useCanReauthenticate } from "./use-can-reauthenticate";

const CURRENT_USER = "user-self";
const TEAM_ID = "team-1";

function setup({
  create,
  update,
  admin,
  teams,
}: {
  create: boolean;
  update: boolean;
  admin: boolean;
  teams?: Array<{
    id: string;
    members?: Array<{ userId: string; role: string }>;
  }>;
}) {
  mockSession.mockReturnValue({ data: { user: { id: CURRENT_USER } } });
  mockMyTeams.mockReturnValue({ data: teams ?? [] });
  mockHasPermissions.mockImplementation(
    (perm: { mcpServerInstallation?: string[] }) => {
      const actions = perm.mcpServerInstallation ?? [];
      if (actions.includes("create")) return { data: create };
      if (actions.includes("update")) return { data: update };
      if (actions.includes("admin")) return { data: admin };
      return { data: false };
    },
  );
  return renderHook(() => useCanReauthenticate()).result.current;
}

describe("useCanReauthenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("denies everything without mcpServerInstallation:create", () => {
    const canReauth = setup({ create: false, update: true, admin: true });
    expect(canReauth({ scope: "personal", ownerId: CURRENT_USER })).toBe(false);
    expect(canReauth({ scope: "org" })).toBe(false);
  });

  it("permits a personal connection only for its owner", () => {
    const canReauth = setup({ create: true, update: true, admin: false });
    expect(canReauth({ scope: "personal", ownerId: CURRENT_USER })).toBe(true);
    expect(canReauth({ scope: "personal", ownerId: "someone-else" })).toBe(
      false,
    );
  });

  it("permits an org connection only with mcpServerInstallation:admin", () => {
    expect(
      setup({ create: true, update: true, admin: false })({ scope: "org" }),
    ).toBe(false);
    expect(
      setup({ create: true, update: false, admin: true })({ scope: "org" }),
    ).toBe(true);
  });

  it("permits a team connection for a team admin", () => {
    const canReauth = setup({
      create: true,
      update: false,
      admin: false,
      teams: [
        {
          id: TEAM_ID,
          members: [{ userId: CURRENT_USER, role: ADMIN_ROLE_NAME }],
        },
      ],
    });
    expect(canReauth({ scope: "team", teamId: TEAM_ID })).toBe(true);
  });

  it("permits a team connection for a member with update, denies without it", () => {
    const teams = [
      { id: TEAM_ID, members: [{ userId: CURRENT_USER, role: "member" }] },
    ];
    expect(
      setup({ create: true, update: true, admin: false, teams })({
        scope: "team",
        teamId: TEAM_ID,
      }),
    ).toBe(true);
    expect(
      setup({ create: true, update: false, admin: false, teams })({
        scope: "team",
        teamId: TEAM_ID,
      }),
    ).toBe(false);
  });

  it("infers team scope from teamId when scope is absent", () => {
    const canReauth = setup({
      create: true,
      update: true,
      admin: false,
      teams: [
        { id: TEAM_ID, members: [{ userId: CURRENT_USER, role: "member" }] },
      ],
    });
    expect(canReauth({ scope: null, teamId: TEAM_ID })).toBe(true);
  });
});
