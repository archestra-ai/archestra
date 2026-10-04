import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAllPermissions, useSession } from "@/lib/auth/auth.query";
import { useActiveMemberRole } from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { AccessSection } from "./access-section";

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/auth/permission-sources.query", () => ({
  usePermissionSources: () => ({ data: [] }),
}));

function render(ui: ReactElement) {
  return rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

function mockMyTeams(overrides: Partial<ReturnType<typeof useMyTeams>>) {
  vi.mocked(useMyTeams).mockReturnValue({
    data: [],
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useMyTeams>);
}

function mockRole(role: string | undefined, isPending = false) {
  vi.mocked(useActiveMemberRole).mockReturnValue({
    data: role,
    isPending,
  } as unknown as ReturnType<typeof useActiveMemberRole>);
}

function mockSession(activeOrganizationId: string | null) {
  vi.mocked(useSession).mockReturnValue({
    data: {
      user: { id: "u1", name: "Ada", email: "ada@example.com" },
      session: { activeOrganizationId },
    },
    isPending: false,
  } as unknown as ReturnType<typeof useSession>);
}

describe("AccessSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession("org-1");
    mockRole("member");
    mockMyTeams({ data: [] });
    vi.mocked(useAllPermissions).mockReturnValue({
      data: { agent: ["read", "update"], mcpServer: ["read"] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useAllPermissions>);
  });

  it("lists each assigned role individually, read-only", () => {
    mockRole("admin, platform_admin,custom_reviewer");

    render(<AccessSection />);

    const roles = screen.getByRole("list", { name: "Assigned roles" });
    expect(roles).toHaveTextContent("Admin");
    expect(roles).toHaveTextContent("Platform Admin");
    expect(roles).toHaveTextContent("custom reviewer");
    expect(roles.querySelectorAll("li")).toHaveLength(3);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("waits for the role while there is an organization to have one in", () => {
    mockRole(undefined, true);

    render(<AccessSection />);

    expect(screen.queryByRole("list", { name: "Assigned roles" })).toBeNull();
  });

  it("does not wait on the role when the user has no active organization", () => {
    // With no active organization the role query never enables, so it stays
    // pending forever — the section must not wait on it.
    mockSession(null);
    mockRole(undefined, true);

    render(<AccessSection />);

    const roleRow = screen.getByText("Role").closest("li") as HTMLElement;
    expect(within(roleRow).getByText("None")).toBeVisible();
  });

  it("lists each team with its role and member count", () => {
    mockMyTeams({
      data: [
        {
          id: "t1",
          name: "Platform",
          description: "Core platform team",
          myRole: "admin",
          members: [{ userId: "u1" }, { userId: "u2" }],
        },
        {
          id: "t2",
          name: "Design",
          myRole: "member",
          members: [{ userId: "u1" }],
        },
      ] as unknown as ReturnType<typeof useMyTeams>["data"],
    });

    render(<AccessSection />);

    const teams = screen.getByRole("list", { name: "Your teams" });
    // A team you merely belong to needs no role note; one you admin says so.
    expect(teams).toHaveTextContent("Platform· admin");
    expect(teams).toHaveTextContent("Design");
    expect(teams).not.toHaveTextContent("member");
  });

  it("says so when the user is on no teams", () => {
    render(<AccessSection />);

    expect(screen.queryByRole("list", { name: "Your teams" })).toBeNull();
  });

  it("offers a retry when the teams fail to load", async () => {
    const refetch = vi.fn();
    mockMyTeams({ data: undefined, isLoadingError: true, refetch });

    render(<AccessSection />);

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("sums what the user is granted and opens the full matrix on demand", async () => {
    render(<AccessSection />);

    expect(screen.getByText("granted").closest("span")).toHaveTextContent(
      "3 granted",
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "View" }));

    expect(
      screen.getByRole("dialog", { name: "Your permissions" }),
    ).toBeVisible();
  });
});
