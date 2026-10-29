import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { useTeamLimitAccess } from "./limits-access";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");
beforeEach(() => {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "lead" } },
  } as ReturnType<typeof useSession>);
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMyTeams).mockReturnValue({
    data: [
      { id: "a", myRole: "admin" },
      { id: "b", myRole: "member" },
    ],
    isPending: false,
  } as ReturnType<typeof useMyTeams>);
});
it("opens Limits for a lead and grants writes only to directly administered teams", () => {
  const { result } = renderHook(useTeamLimitAccess);
  expect(result.current.canRead).toBe(true);
  expect(result.current.globalRead).toBe(false);
  expect(result.current.teams.map((team) => team.id)).toEqual(["a"]);
  for (const action of ["create", "update", "delete"] as const) {
    expect(
      result.current.allows(action, { entityType: "team", entityId: "a" }),
    ).toBe(true);
    expect(
      result.current.allows(action, { entityType: "team", entityId: "b" }),
    ).toBe(false);
    expect(
      result.current.allows(action, {
        entityType: "organization",
        entityId: "a",
      }),
    ).toBe(false);
  }
});
it("preserves each organization action independently", () => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: permissions.llmLimit?.includes("read") ?? false,
        isPending: false,
      }) as ReturnType<typeof useHasPermissions>,
  );
  const { result } = renderHook(useTeamLimitAccess);
  expect(result.current.globalRead).toBe(true);
  expect(result.current.globalCreate).toBe(false);
  expect(
    result.current.allows("delete", { entityType: "team", entityId: "b" }),
  ).toBe(false);
});
it("does not open Limits for ordinary members", () => {
  vi.mocked(useMyTeams).mockReturnValue({
    data: [{ id: "a", myRole: "member" }],
    isPending: false,
  } as ReturnType<typeof useMyTeams>);
  expect(renderHook(useTeamLimitAccess).result.current.canRead).toBe(false);
});
