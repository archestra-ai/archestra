import type { archestraApiTypes } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamManagementDialog } from "./team-management-dialog";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];

const { useFeatureMock, useHasPermissionsMock, useTokensMock } = vi.hoisted(
  () => ({
    useFeatureMock: vi.fn(),
    useHasPermissionsMock: vi.fn(),
    useTokensMock: vi.fn(),
  }),
);

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

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: useHasPermissionsMock,
}));

vi.mock("@/lib/config/config", () => ({
  default: {
    enterpriseFeatures: {
      core: false,
    },
  },
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: useFeatureMock,
}));

vi.mock("@/lib/teams/team-token.query", () => ({
  useTokens: useTokensMock,
}));

describe("TeamManagementDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFeatureMock.mockReturnValue(true);
    useHasPermissionsMock.mockReturnValue({ data: false });
    useTokensMock.mockReturnValue({ data: { tokens: [] } });
  });

  it("hides token and vault tabs from team admins without team:update", () => {
    renderDialog();

    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("External Group Sync")).toBeInTheDocument();
    expect(screen.queryByText("MCP/A2A Gateway Token")).not.toBeInTheDocument();
    expect(screen.queryByText("Vault Folder")).not.toBeInTheDocument();
  });

  it("shows token and vault tabs to users with team:update when vault is enabled", () => {
    useHasPermissionsMock.mockReturnValue({ data: true });

    renderDialog();

    expect(screen.getByText("MCP/A2A Gateway Token")).toBeInTheDocument();
    expect(screen.getByText("Vault Folder")).toBeInTheDocument();
  });

  it("hides the vault tab when vault is disabled", () => {
    useHasPermissionsMock.mockReturnValue({ data: true });
    useFeatureMock.mockReturnValue(false);

    renderDialog();

    expect(screen.getByText("MCP/A2A Gateway Token")).toBeInTheDocument();
    expect(screen.queryByText("Vault Folder")).not.toBeInTheDocument();
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
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    convertToolResultsToToon: false,
    members: [],
  };
}
