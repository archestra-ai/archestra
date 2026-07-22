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
import { AgentScopeFilter } from "./agent-scope-filter";

describe("AgentScopeFilter owner selector gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("scope=personal") as ReturnType<
        typeof useSearchParams
      >,
    );
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

  it("hides the owner selector for a non-admin even if they have member:read", async () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions: Record<string, unknown>) => {
        // Has member:read and team:read, but NOT agent:admin.
        if ("agent" in permissions)
          return { data: false } as ReturnType<typeof useHasPermissions>;
        return { data: true } as ReturnType<typeof useHasPermissions>;
      },
    );

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByText("Other users")).not.toBeInTheDocument();
  });

  it("shows the owner selector for a resource admin", async () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions: Record<string, unknown>) => {
        if ("agent" in permissions)
          return { data: true } as ReturnType<typeof useHasPermissions>;
        return { data: true } as ReturnType<typeof useHasPermissions>;
      },
    );

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);

    await userEvent.click(comboboxes[1]);
    expect(await screen.findByText("Other users")).toBeInTheDocument();
  });
});
