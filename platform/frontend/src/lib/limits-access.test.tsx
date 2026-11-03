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
      {
        id: "a",
        name: "Parent",
        myRole: "admin",
        descendantTeams: [{ id: "child", name: "Child" }],
      },
      { id: "b", myRole: "member" },
    ],
    isPending: false,
  } as ReturnType<typeof useMyTeams>);
});
it("opens Limits for a lead and grants writes to descendants while keeping the own ceiling read-only", () => {
  const { result } = renderHook(useTeamLimitAccess);
  expect(result.current.canRead).toBe(true);
  expect(result.current.globalRead).toBe(false);
  expect(result.current.teams.map((team) => team.id)).toEqual(["a", "child"]);
  for (const action of ["create", "update", "delete"] as const) {
    expect(
      result.current.allows(action, {
        entityType: "team",
        entityId: "child",
        teamManaged: false,
      }),
    ).toBe(true);
    expect(
      result.current.allows(action, { entityType: "team", entityId: "a" }),
    ).toBe(false);
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
it("keeps a directly administered child writable through its parent while protecting each top-level ceiling", () => {
  vi.mocked(useMyTeams).mockReturnValue({
    data: [
      {
        id: "parent",
        myRole: "admin",
        descendantTeams: [{ id: "child", name: "Child" }],
      },
      { id: "child", myRole: "admin", descendantTeams: [] },
      { id: "other", myRole: "admin", descendantTeams: [] },
    ],
    isPending: false,
  } as ReturnType<typeof useMyTeams>);
  const { result, rerender } = renderHook(useTeamLimitAccess);
  expect(result.current.managedTeams.map((team) => team.id)).toEqual(["child"]);
  for (const action of ["create", "update", "delete"] as const) {
    expect(
      result.current.allows(action, { entityType: "team", entityId: "child" }),
    ).toBe(true);
    for (const entityId of ["parent", "other"]) {
      expect(
        result.current.allows(action, { entityType: "team", entityId }),
      ).toBe(false);
      expect(result.current.isLocked({ entityType: "team", entityId })).toBe(
        true,
      );
    }
  }
  expect(
    result.current.isLocked({ entityType: "team", entityId: "child" }),
  ).toBe(false);
  vi.mocked(useMyTeams).mockReturnValue({
    data: [
      { id: "child", name: "Child", myRole: "admin", descendantTeams: [] },
    ],
    isPending: false,
  } as unknown as ReturnType<typeof useMyTeams>);
  rerender();
  expect(result.current.managedTeams).toEqual([]);
  expect(
    result.current.isLocked({ entityType: "team", entityId: "child" }),
  ).toBe(true);
});
it("does not open Limits for ordinary members", () => {
  vi.mocked(useMyTeams).mockReturnValue({
    data: [{ id: "a", myRole: "member" }],
    isPending: false,
  } as ReturnType<typeof useMyTeams>);
  expect(renderHook(useTeamLimitAccess).result.current.canRead).toBe(false);
});
