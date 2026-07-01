import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select relies on pointer-capture / scrollIntoView, which jsdom omits.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

const mockUseHasPermissions = vi.fn();
const mockUseSession = vi.fn();
const mockUseSearchParams = vi.fn();

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: (...args: unknown[]) => mockUseHasPermissions(...args),
  useSession: (...args: unknown[]) => mockUseSession(...args),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: (...args: unknown[]) => mockUseSearchParams(...args),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/agents",
}));

vi.mock("@/lib/agent.query", () => ({
  useLabelKeys: () => ({ data: [] }),
  useLabelValues: () => ({ data: [] }),
}));

vi.mock("@/lib/organization.query", () => ({
  useOrganizationMembers: () => ({ data: [] }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

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

import { AgentScopeFilter } from "./agent-scope-filter";

describe("AgentScopeFilter owner selector gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({ data: { user: { id: "user-1" } } });
    mockUseSearchParams.mockReturnValue(new URLSearchParams("scope=personal"));
  });

  it("hides the owner selector for a non-admin even if they have member:read", async () => {
    mockUseHasPermissions.mockImplementation(
      (permissions: Record<string, unknown>) => {
        // Has member:read and team:read, but NOT agent:admin.
        if ("agent" in permissions) return { data: false };
        return { data: true };
      },
    );

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByText("Other users")).not.toBeInTheDocument();
  });

  it("shows the owner selector for a resource admin", async () => {
    mockUseHasPermissions.mockImplementation(
      (permissions: Record<string, unknown>) => {
        if ("agent" in permissions) return { data: true };
        return { data: true };
      },
    );

    render(<AgentScopeFilter adminPermission={{ agent: ["admin"] }} />);

    const comboboxes = screen.getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);

    await userEvent.click(comboboxes[1]);
    expect(await screen.findByText("Other users")).toBeInTheDocument();
  });
});
