import { render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeams } from "@/lib/teams/team.query";
import ConnectorsPage from "./page.client";

const mockUseConnectorsPaginated = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorsPaginated: (params: unknown) =>
    mockUseConnectorsPaginated(params),
  useConnector: () => ({ data: null }),
  useDeleteConnector: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("next/navigation");
vi.mock("@/lib/teams/team.query");

// Heavy child dialogs and the create-gate layout chrome are out of scope.
vi.mock(
  "@/app/knowledge/knowledge-bases/_parts/create-connector-dialog",
  () => ({ CreateConnectorDialog: () => null }),
);
vi.mock("@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog", () => ({
  EditConnectorDialog: () => null,
}));
vi.mock("@/app/knowledge/_parts/knowledge-page-layout", () => ({
  KnowledgePageLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

function makeConnector(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    name: "Connector",
    description: null,
    connectorType: "jira",
    visibility: "org-wide",
    teamIds: [],
    enabled: true,
    lastSyncStatus: "success",
    lastSyncAt: "2026-07-13T10:00:00.000Z",
    schedule: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/knowledge/connectors");
  vi.mocked(useSearchParams).mockReturnValue({
    get: () => null,
    toString: () => "",
  } as unknown as ReturnType<typeof useSearchParams>);
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useTeams).mockReturnValue({
    data: [{ id: "team-1", name: "Platform Team" }],
  } as unknown as ReturnType<typeof useTeams>);
  mockUseConnectorsPaginated.mockReturnValue({
    data: {
      data: [
        makeConnector({ name: "Org Connector", visibility: "org-wide" }),
        makeConnector({
          name: "Team Connector",
          visibility: "team-scoped",
          teamIds: ["team-1"],
        }),
        makeConnector({
          name: "Synced Connector",
          visibility: "auto-sync-permissions",
        }),
      ],
      pagination: { total: 3 },
    },
    isPending: false,
    isError: false,
  });
});

describe("ConnectorsPage", () => {
  it("shows who each connector is accessible to, in the shared scope badge language", () => {
    render(<ConnectorsPage />);

    // Org-wide -> the amber Organization badge; team-scoped -> the team's
    // name; auto-sync -> the violet Source permissions badge with its
    // explanation on hover.
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getByText("Platform Team")).toBeInTheDocument();
    expect(screen.getByText("Source permissions")).toBeInTheDocument();
    expect(
      screen.getByText(/mirrors the source system's own permissions/),
    ).toBeInTheDocument();
  });
});
