import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";
import ConnectorsPage from "./page.client";

const mockUseConnectorsPaginated = vi.fn();
const mockRestoreMutate = vi.fn();
const mockPurgeMutateAsync = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorsPaginated: (params: unknown) =>
    mockUseConnectorsPaginated(params),
  useConnector: () => ({ data: null }),
  useDeleteConnector: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRestoreConnector: () => ({
    mutate: mockRestoreMutate,
    isPending: false,
  }),
  usePurgeConnector: () => ({
    mutateAsync: mockPurgeMutateAsync,
    isPending: false,
  }),
}));

vi.mock("next/navigation");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

// The status filter reads permissions and URL state of its own; its behavior
// is the shared component's contract, not this page's.
vi.mock("@/components/resource-scope-filter", () => ({
  ResourceDeletedStatusFilter: () => <div>status filter</div>,
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div>{title}</div> : null,
}));

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
  vi.clearAllMocks();
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
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useFeature).mockReturnValue(
    undefined as ReturnType<typeof useFeature>,
  );
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

  it("deleted view: rows collapse to Restore + Delete permanently with the purge countdown", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=deleted") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useFeature).mockReturnValue({
      enabled: true,
      days: 30,
    } as unknown as ReturnType<typeof useFeature>);
    const deletedAt = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();
    mockUseConnectorsPaginated.mockReturnValue({
      data: {
        data: [
          makeConnector({
            id: "conn-1",
            name: "Trashed Connector",
            deletedAt,
          }),
        ],
        pagination: { total: 1 },
      },
      isPending: false,
      isFetching: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });

    render(<ConnectorsPage />);

    // The list is requested with the deleted slice.
    expect(mockUseConnectorsPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" }),
    );

    // Trash metadata: "Deleted N ago" plus the retention countdown, phrased
    // as eligibility — the sweep can lag, so no exact purge moment.
    expect(screen.getByText(/^Deleted /)).toBeInTheDocument();
    expect(
      screen.getByText(/Eligible for deletion in \d+ days/),
    ).toBeInTheDocument();

    // The active-view actions are gone; the trash pair remains.
    expect(screen.queryByLabelText(/Edit connector/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/^Restore/));
    expect(mockRestoreMutate).toHaveBeenCalledWith("conn-1");

    await userEvent.click(screen.getByLabelText(/^Delete permanently/));
    expect(
      screen.getByText("Delete connector permanently"),
    ).toBeInTheDocument();
  });
});
