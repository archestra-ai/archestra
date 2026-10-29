import type { archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useTeam,
  useTeamLabelKeys,
  useTeamLabelValues,
  useTeams,
} from "@/lib/teams/team.query";
import { TeamsList } from "./teams-list";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { mockSetSettingsAction, queryParamsHolder } = vi.hoisted(() => ({
  mockSetSettingsAction: vi.fn(),
  queryParamsHolder: { current: new URLSearchParams() },
}));

vi.mock("next/navigation");

vi.mock("@/app/settings/layout", () => ({
  useSetSettingsAction: () => mockSetSettingsAction,
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}));

vi.mock("@/components/search-input", () => ({
  SearchInput: () => null,
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    columns,
    data,
  }: {
    columns: ColumnDef<Team>[];
    data: Team[];
  }) => {
    const actionsColumn = columns.find((column) => column.id === "actions");
    const parentColumn = columns.find((column) => column.id === "parent");
    const membersColumn = columns.find((column) => column.id === "members");
    return (
      <div>
        {data.map((team) => (
          <div key={team.id}>
            {typeof parentColumn?.cell === "function"
              ? parentColumn.cell({
                  row: { original: team },
                } as Parameters<NonNullable<typeof parentColumn.cell>>[0])
              : null}
            {typeof membersColumn?.cell === "function"
              ? membersColumn.cell({
                  row: { original: team },
                } as Parameters<NonNullable<typeof membersColumn.cell>>[0])
              : null}
            {typeof actionsColumn?.cell === "function"
              ? actionsColumn.cell({
                  row: { original: team },
                } as Parameters<NonNullable<typeof actionsColumn.cell>>[0])
              : null}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/ui/permission-button", () => ({
  PermissionButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/table-row-actions", () => ({
  TableRowActions: ({
    actions,
  }: {
    actions: Array<{
      label: string;
      disabled?: boolean;
      onClick?: () => void;
      testId?: string;
    }>;
  }) => (
    <div>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          aria-label={action.label}
          data-testid={action.testId}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: queryParamsHolder.current,
    updateQueryParams: vi.fn(),
  }),
}));

vi.mock("@/lib/teams/team.query");

vi.mock("./team-management-dialog", () => ({
  TeamManagementDialog: ({
    open,
    team,
    readOnly,
  }: {
    open: boolean;
    team?: Team | null;
    readOnly?: boolean;
  }) =>
    open ? (
      <div data-read-only={String(!!readOnly)}>
        Edit dialog for {team?.name ?? "new team"}
      </div>
    ) : null,
}));

describe("TeamsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace: vi.fn(),
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue("/settings/teams");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: !permissions.team?.includes("update"),
        }) as ReturnType<typeof useHasPermissions>,
    );
    vi.mocked(useTeam).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useTeam>);
    vi.mocked(useTeamLabelKeys).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeamLabelKeys>);
    vi.mocked(useTeamLabelValues).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeamLabelValues>);
    vi.mocked(useTeams).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);
    queryParamsHolder.current = new URLSearchParams();
  });

  it("lets literal team admins edit their team without organization-level team update permission", () => {
    // List rows carry no member arrays; the caller's role comes from myRole.
    vi.mocked(useTeams).mockReturnValue({
      data: [makeTeam({ myRole: "admin", memberCount: 12 })],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);

    renderTeamsList();

    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(editButton).toBeEnabled();

    fireEvent.click(editButton);

    expect(screen.getByText("Edit dialog for Team A")).toBeInTheDocument();
  });

  it("lets a team admin opened from the URL edit by the single-team role", () => {
    queryParamsHolder.current = new URLSearchParams("team=team-a");
    // The single-team response has no member array, only the caller's role.
    vi.mocked(useTeam).mockReturnValue({
      data: makeTeam({ myRole: "admin" }),
    } as unknown as ReturnType<typeof useTeam>);
    vi.mocked(useSearchParams).mockReturnValue(
      queryParamsHolder.current as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    renderTeamsList();

    expect(screen.getByText("Edit dialog for Team A")).toHaveAttribute(
      "data-read-only",
      "false",
    );
  });

  it("shows the member count from memberCount without member arrays", () => {
    vi.mocked(useTeams).mockReturnValue({
      data: [
        makeTeam({ id: "big", name: "Big", memberCount: 2500 }),
        makeTeam({ id: "solo", name: "Solo", memberCount: 1 }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);

    renderTeamsList();

    // The plural suffix is its own element, so match the cell's full text.
    const memberCell = (text: string) =>
      screen.getByText(
        (_, element) =>
          element?.tagName === "DIV" && element.textContent === text,
      );
    expect(memberCell("2500 members")).toBeInTheDocument();
    expect(memberCell("1 member")).toBeInTheDocument();
  });

  it("counts member arrays from a backend that sends no memberCount", () => {
    const oldBackendRow = {
      ...makeTeam({ id: "old", name: "Old" }),
      memberCount: undefined,
      members: [
        makeTeamMember({ id: "m1", userId: "user-1" }),
        makeTeamMember({ id: "m2", userId: "user-2" }),
      ],
    } as unknown as Team;
    vi.mocked(useTeams).mockReturnValue({
      data: [oldBackendRow],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);

    renderTeamsList();

    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "DIV" && element.textContent === "2 members",
      ),
    ).toBeInTheDocument();
  });

  it("shows the immediate parent in the hierarchy column", () => {
    const parent = makeTeam({ id: "parent", name: "Product" });
    const child = makeTeam({
      id: "child",
      name: "Platform",
      parentId: parent.id,
    });
    vi.mocked(useTeams).mockReturnValue({
      data: [parent, child],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);

    renderTeamsList();

    expect(screen.getByText("Product")).toBeInTheDocument();
  });

  it("keeps edit disabled for regular team members without team update or identity-provider read permission", () => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useTeams).mockReturnValue({
      data: [makeTeam({ myRole: "member" })],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);

    renderTeamsList();

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("offers identity-provider readers a view-only group sync action instead of edit", () => {
    // The default useHasPermissions mock grants everything except team:update,
    // so this member holds identityProvider:read but cannot manage the team.
    vi.mocked(useTeams).mockReturnValue({
      data: [makeTeam({ myRole: "member" })],
      isLoading: false,
    } as unknown as ReturnType<typeof useTeams>);

    renderTeamsList();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    const viewButton = screen.getByRole("button", { name: "View group sync" });
    expect(viewButton).toBeEnabled();

    fireEvent.click(viewButton);

    expect(screen.getByText("Edit dialog for Team A")).toBeInTheDocument();
  });

  it("passes the name and labels URL params to the teams query (server-side filtering)", () => {
    queryParamsHolder.current = new URLSearchParams(
      "search=platform&labels=env:prod",
    );

    renderTeamsList();

    expect(useTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "platform",
        labels: "env:prod",
        includeMembers: false,
      }),
    );
  });
});

function renderTeamsList() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TeamsList />
    </QueryClientProvider>,
  );
}

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: "team-a",
    name: "Team A",
    description: null,
    organizationId: "org-1",
    parentId: null,
    createdBy: "user-2",
    createdByServiceAccountId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roles: [],
    memberCount: 0,
    ...overrides,
  };
}

function makeTeamMember(
  overrides: Partial<NonNullable<Team["members"]>[number]> = {},
): NonNullable<Team["members"]>[number] {
  return {
    id: "team-member-1",
    teamId: "team-a",
    userId: "user-1",
    role: "member",
    syncedFromSso: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
