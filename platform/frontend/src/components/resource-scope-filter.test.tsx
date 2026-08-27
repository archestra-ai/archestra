import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select relies on pointer-capture / scrollIntoView, which jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

vi.mock("@/lib/auth/auth.query");

vi.mock("next/navigation");

vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

vi.mock("@/lib/organization.query");

vi.mock("@/lib/teams/team.query");

// Stub the sibling controls so the only `combobox` roles in the tree are the
// scope select and the (conditional) owner select under test.
vi.mock("@/components/label-select", () => ({
  LabelSelect: () => null,
  LabelFilterBadges: () => null,
  LabelKeyRowBase: () => null,
  parseLabelsParam: () => null,
  serializeLabels: () => "",
}));
vi.mock("@/components/ui/multi-select", () => ({ MultiSelect: () => null }));
vi.mock("@/components/user-searchable-multi-select", () => ({
  UserSearchableMultiSelect: () => null,
}));
vi.mock("@/components/permission-requirement-hint", () => ({
  PermissionRequirementHint: () => null,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import {
  ResourceScopeFilter,
  useScopeFilterParams,
} from "./resource-scope-filter";

function mockSearchParams(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useSession).mockReturnValue({
    data: { user: { id: "user-1" } },
  } as ReturnType<typeof useSession>);
  mockSearchParams("scope=personal");
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/agents");
  vi.mocked(useOrganizationMembers).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useOrganizationMembers>);
  vi.mocked(useTeams).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useTeams>);
});

describe("ResourceScopeFilter owner selector gating", () => {
  it("hides the owner selector for a non-admin even if they have member:read", async () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions: Record<string, unknown>) => {
        // Has member:read and team:read, but NOT agent:admin.
        if ("agent" in permissions)
          return { data: false } as ReturnType<typeof useHasPermissions>;
        return { data: true } as ReturnType<typeof useHasPermissions>;
      },
    );

    render(
      <ResourceScopeFilter
        ownerLabelPlural="agents"
        adminPermission={{ agent: ["admin"] }}
      />,
    );

    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByText("Other users")).not.toBeInTheDocument();
  });

  it("shows the owner selector for a resource admin", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);

    render(
      <ResourceScopeFilter
        ownerLabelPlural="agents"
        adminPermission={{ agent: ["admin"] }}
      />,
    );

    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);

    await userEvent.click(comboboxes[1]);
    expect(await screen.findByText("Other users")).toBeInTheDocument();
  });

  it("uses a caller-owned local navigation path when provided", async () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
    } as ReturnType<typeof useHasPermissions>);
    const navigate = vi.fn();

    render(
      <ResourceScopeFilter
        ownerLabelPlural="connections"
        adminPermission={{ mcpServerInstallation: ["admin"] }}
        navigate={navigate}
      />,
    );

    await userEvent.click(screen.getAllByRole("combobox")[0]);
    await userEvent.click(screen.getByRole("option", { name: "All types" }));

    expect(navigate).toHaveBeenCalledWith("/agents?");
    expect(useRouter().push).not.toHaveBeenCalled();
  });
});

describe("useScopeFilterParams", () => {
  // structural type: ReturnType<> of an overloaded hook only sees the last
  // overload, which is too narrow for the includeBuiltIn variant.
  interface ParsedScopeParams {
    scope: string | undefined;
    teamIds: string[] | undefined;
    authorIds: string[] | undefined;
    excludeAuthorIds: string[] | undefined;
    excludeOtherPersonal: true | undefined;
    hasActiveScopeFilters: boolean;
  }

  // probes append instead of assigning a captured `let`: TS doesn't track
  // closure assignments, so a plain variable would narrow to `never` after
  // the guard below.
  const results: ParsedScopeParams[] = [];

  function ProbeDefault() {
    results.push(useScopeFilterParams());
    return null;
  }

  function ProbeBuiltIn() {
    results.push(useScopeFilterParams({ includeBuiltIn: true }));
    return null;
  }

  function readParams(query: string, options?: { includeBuiltIn: true }) {
    mockSearchParams(query);
    results.length = 0;
    render(options ? <ProbeBuiltIn /> : <ProbeDefault />);
    const result = results.at(-1);
    if (!result) throw new Error("hook did not run");
    return result;
  }

  it("parses scope and comma-separated ids, defaulting excludeOtherPersonal", () => {
    expect(readParams("")).toEqual({
      scope: undefined,
      teamIds: undefined,
      authorIds: undefined,
      excludeAuthorIds: undefined,
      excludeOtherPersonal: true,
      hasActiveScopeFilters: false,
    });
    expect(readParams("scope=team&teamIds=t1,t2")).toMatchObject({
      scope: "team",
      teamIds: ["t1", "t2"],
      excludeOtherPersonal: true,
      hasActiveScopeFilters: true,
    });
    // an active personal/owner filter turns the default exclusion off
    expect(readParams("scope=personal&authorIds=user-2")).toMatchObject({
      scope: "personal",
      authorIds: ["user-2"],
      excludeOtherPersonal: undefined,
    });
  });

  it("drops built_in and unknown scopes unless opted in", () => {
    expect(readParams("scope=built_in").scope).toBeUndefined();
    expect(readParams("scope=garbage").scope).toBeUndefined();
    expect(readParams("scope=built_in", { includeBuiltIn: true }).scope).toBe(
      "built_in",
    );
  });
});
