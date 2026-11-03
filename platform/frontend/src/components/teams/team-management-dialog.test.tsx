import type { archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { TeamManagementDialog } from "./team-management-dialog";

type Team = archestraApiTypes.GetTeamResponses["200"];

vi.mock("@/components/tabbed-dialog-shell", () => ({
  TabbedDialogShell: ({
    navItems,
  }: {
    navItems: Array<{ id: string; label: string }>;
  }) => (
    <div>
      {navItems.map((item) => (
        <div key={item.id}>{item.label}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: false,
    },
  },
}));

vi.mock("@/lib/config/config.query");

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

describe("TeamManagementDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeature).mockReturnValue(
      true as ReturnType<typeof useFeature>,
    );
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
  });

  it("shows team management sections to team admins", () => {
    renderDialog();

    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByText("Team Sync")).toBeInTheDocument();
  });

  it("shows the appropriate team sections", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
      typeof useHasPermissions
    >);
    vi.mocked(useFeature).mockReturnValue(
      false as ReturnType<typeof useFeature>,
    );

    renderDialog();

    expect(screen.getByText("Team Sync")).toBeInTheDocument();
  });
});

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TeamManagementDialog open onOpenChange={vi.fn()} team={makeTeam()} />
    </QueryClientProvider>,
  );
}

function makeTeam(): Team {
  return {
    id: "team-a",
    name: "Team A",
    description: null,
    organizationId: "org-1",
    parentId: null,
    createdBy: "user-1",
    createdByServiceAccountId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roles: [],
    members: [],
  };
}
