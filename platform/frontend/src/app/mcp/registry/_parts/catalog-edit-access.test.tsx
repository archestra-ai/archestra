import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/teams/team.query");

import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { useCanModifyCatalogItem } from "./catalog-edit-access";

const CURRENT_USER = "user-self";

type CatalogItem = Parameters<typeof useCanModifyCatalogItem>[0];

function setup({
  admin,
  teams,
  catalog,
}: {
  admin: boolean;
  teams?: Array<{ id: string; myRole: string }>;
  catalog: CatalogItem;
}) {
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: CURRENT_USER } },
    isPending: false,
  } as ReturnType<typeof useSession>);
  vi.mocked(useMyTeams).mockReturnValue({
    data: teams ?? [],
    isLoading: false,
  } as unknown as ReturnType<typeof useMyTeams>);
  vi.mocked(useHasPermissions).mockImplementation(((perm: {
    mcpServerInstallation?: string[];
    team?: string[];
  }) => {
    if (perm.mcpServerInstallation?.includes("admin"))
      return { data: admin, isLoading: false };
    if (perm.team?.includes("read")) return { data: true, isLoading: false };
    return { data: false, isLoading: false };
  }) as unknown as typeof useHasPermissions);
  return renderHook(() => useCanModifyCatalogItem(catalog)).result.current
    .canModify;
}

function catalogItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    scope: "team",
    authorId: "some-author",
    teams: [],
    ...overrides,
  } as unknown as CatalogItem;
}

describe("useCanModifyCatalogItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("denies when there is no catalog item", () => {
    expect(setup({ admin: false, catalog: null })).toBe(false);
  });

  it("permits an mcpServerInstallation admin at any scope", () => {
    expect(setup({ admin: true, catalog: catalogItem({ scope: "org" }) })).toBe(
      true,
    );
    expect(
      setup({
        admin: true,
        catalog: catalogItem({ scope: "personal", authorId: "someone-else" }),
      }),
    ).toBe(true);
  });

  it("permits the author of a personal item, denies a non-author", () => {
    expect(
      setup({
        admin: false,
        catalog: catalogItem({ scope: "personal", authorId: CURRENT_USER }),
      }),
    ).toBe(true);
    expect(
      setup({
        admin: false,
        catalog: catalogItem({ scope: "personal", authorId: "someone-else" }),
      }),
    ).toBe(false);
  });

  it("denies a non-admin on an org item even when they authored it", () => {
    expect(
      setup({
        admin: false,
        catalog: catalogItem({ scope: "org", authorId: CURRENT_USER }),
      }),
    ).toBe(false);
  });

  it("permits an admin of a write-level team on the item", () => {
    expect(
      setup({
        admin: false,
        teams: [{ id: "t1", myRole: ADMIN_ROLE_NAME }],
        catalog: catalogItem({
          scope: "team",
          teams: [{ id: "t1", name: "T1", level: "write" }],
        }),
      }),
    ).toBe(true);
  });

  it("denies an admin of a use-level team on the item", () => {
    expect(
      setup({
        admin: false,
        teams: [{ id: "t1", myRole: ADMIN_ROLE_NAME }],
        catalog: catalogItem({
          scope: "team",
          teams: [{ id: "t1", name: "T1", level: "use" }],
        }),
      }),
    ).toBe(false);
  });

  it("denies a plain member of a write-level team on the item", () => {
    expect(
      setup({
        admin: false,
        teams: [{ id: "t1", myRole: MEMBER_ROLE_NAME }],
        catalog: catalogItem({
          scope: "team",
          teams: [{ id: "t1", name: "T1", level: "write" }],
        }),
      }),
    ).toBe(false);
  });

  it("permits when the write team is one of several on the item", () => {
    expect(
      setup({
        admin: false,
        teams: [{ id: "t2", myRole: ADMIN_ROLE_NAME }],
        catalog: catalogItem({
          scope: "team",
          teams: [
            { id: "t1", name: "T1", level: "use" },
            { id: "t2", name: "T2", level: "write" },
          ],
        }),
      }),
    ).toBe(true);
  });
});
