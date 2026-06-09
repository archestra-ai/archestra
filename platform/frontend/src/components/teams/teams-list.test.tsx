import type { archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamsList } from "./teams-list";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const {
  mockSetSettingsAction,
  useHasPermissionsMock,
  useSessionMock,
  useTeamsMock,
} = vi.hoisted(() => ({
  mockSetSettingsAction: vi.fn(),
  useHasPermissionsMock: vi.fn(),
  useSessionMock: vi.fn(),
  useTeamsMock: vi.fn(),
}));

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
    return (
      <div>
        {data.map((team) => (
          <div key={team.id}>
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

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: useHasPermissionsMock,
  useSession: useSessionMock,
}));

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: new URLSearchParams(),
    updateQueryParams: vi.fn(),
  }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: useTeamsMock,
}));

vi.mock("./team-management-dialog", () => ({
  TeamManagementDialog: ({
    open,
    team,
  }: {
    open: boolean;
    team?: Team | null;
  }) => (open ? <div>Edit dialog for {team?.name ?? "new team"}</div> : null),
}));

describe("TeamsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionMock.mockReturnValue({ data: { user: { id: "user-1" } } });
    useHasPermissionsMock.mockImplementation((permissions) => ({
      data: !permissions.team?.includes("update"),
    }));
  });

  it("lets literal team admins edit their team without organization-level team update permission", () => {
    useTeamsMock.mockReturnValue({
      data: [
        makeTeam({
          members: [
            makeTeamMember({
              userId: "user-1",
              role: "admin",
            }),
          ],
        }),
      ],
      isLoading: false,
    });

    renderTeamsList();

    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(editButton).toBeEnabled();

    fireEvent.click(editButton);

    expect(screen.getByText("Edit dialog for Team A")).toBeInTheDocument();
  });

  it("keeps edit disabled for regular team members without organization-level team update permission", () => {
    useTeamsMock.mockReturnValue({
      data: [
        makeTeam({
          members: [
            makeTeamMember({
              userId: "user-1",
              role: "member",
            }),
          ],
        }),
      ],
      isLoading: false,
    });

    renderTeamsList();

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
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
    createdBy: "user-2",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    convertToolResultsToToon: false,
    members: [],
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
