import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionsCard } from "@/components/settings/permissions-card";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/organization.query");

function mockPermissions(permissions: Record<string, string[]> | null) {
  vi.mocked(useAllPermissions).mockReturnValue({
    data: permissions,
    isLoading: false,
  } as unknown as ReturnType<typeof useAllPermissions>);
}

describe("PermissionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useActiveMemberRole).mockReturnValue({
      data: "admin",
      isPending: false,
    } as unknown as ReturnType<typeof useActiveMemberRole>);
    mockPermissions({
      agent: ["create", "read"],
      mcpGateway: ["read"],
    });
  });

  it("tells the reader which role the grants come from", () => {
    render(<PermissionsCard />);

    expect(screen.getByText("admin")).toBeInTheDocument();
    // Two granted resources, in the Agents and MCP categories.
    expect(screen.getByText(/2 resources across 2 categories/)).toBeVisible();
  });

  it("says so when the role grants nothing", () => {
    mockPermissions({});

    render(<PermissionsCard />);

    expect(
      screen.getByText("Your role grants no resource permissions."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Filter permissions")).toBeNull();
  });

  it("expands and collapses every category at once", () => {
    render(<PermissionsCard />);

    // Collapsed: the category headers are there, the resources are not.
    expect(screen.queryByText("Agents")).toBeVisible();
    expect(screen.queryByText("MCP Gateways")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByText("MCP Gateways")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("MCP Gateways")).toBeNull();
  });

  it("filters to matching resources and opens the categories that survive", () => {
    render(<PermissionsCard />);

    fireEvent.change(screen.getByLabelText("Filter permissions"), {
      target: { value: "gateway" },
    });

    // Matching rows are revealed without having to expand anything, and the
    // category with no match drops out entirely.
    expect(screen.getByText("MCP Gateways")).toBeVisible();
    expect(screen.queryByText("Agents")).toBeNull();
    expect(screen.getByText("MCP")).toBeVisible();
  });

  it("filters on action names too", () => {
    render(<PermissionsCard />);

    fireEvent.change(screen.getByLabelText("Filter permissions"), {
      target: { value: "create" },
    });

    // Only the agent resource carries a Create action, so the MCP category
    // drops out. "Agents" names both the category and the agent resource.
    expect(screen.getAllByText("Agents").length).toBeGreaterThan(0);
    expect(screen.queryByText("MCP")).toBeNull();
    expect(screen.queryByText("MCP Gateways")).toBeNull();
  });

  it("says when nothing matches the filter", () => {
    render(<PermissionsCard />);

    fireEvent.change(screen.getByLabelText("Filter permissions"), {
      target: { value: "zzzz" },
    });

    expect(screen.getByText("No permissions match that filter.")).toBeVisible();
  });
});
