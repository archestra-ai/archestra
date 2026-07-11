import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");

vi.mock("next/navigation");

vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

vi.mock("@/lib/organization.query");

vi.mock("@/lib/teams/team.query");

// Stub the sibling controls; the user multi-select stub renders a marker so
// its gating can be asserted without pulling in the real component.
vi.mock("@/components/label-select", () => ({
  LabelSelect: () => null,
  LabelFilterBadges: () => null,
  LabelKeyRowBase: () => null,
  parseLabelsParam: () => null,
  serializeLabels: () => "",
}));
vi.mock("@/components/ui/multi-select", () => ({ MultiSelect: () => null }));
vi.mock("@/components/user-searchable-multi-select", () => ({
  UserSearchableMultiSelect: () => <div data-testid="user-multi-select" />,
}));
vi.mock("@/components/permission-requirement-hint", () => ({
  PermissionRequirementHint: () => null,
}));

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { AgentScopeFilter } from "./agent-scope-filter";

function mockIsAdmin(isAdmin: boolean) {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions: Record<string, unknown>) => {
      // Has member:read and team:read; agent:admin per the flag.
      if ("agent" in permissions)
        return { data: isAdmin } as ReturnType<typeof useHasPermissions>;
      return { data: true } as ReturnType<typeof useHasPermissions>;
    },
  );
}

describe("AgentScopeFilter user multi-select gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("adminView=true") as ReturnType<
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

  it("hides the user multi-select for a non-admin even with adminView=true", () => {
    mockIsAdmin(false);

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    expect(screen.queryByTestId("user-multi-select")).not.toBeInTheDocument();
  });

  it("shows the user multi-select for a resource admin with adminView=true", () => {
    mockIsAdmin(true);

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    expect(screen.getByTestId("user-multi-select")).toBeInTheDocument();
  });

  it("hides the user multi-select for an admin without adminView", () => {
    mockIsAdmin(true);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("scope=personal") as ReturnType<
        typeof useSearchParams
      >,
    );

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    expect(screen.queryByTestId("user-multi-select")).not.toBeInTheDocument();
  });
});
