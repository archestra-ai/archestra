import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import KnowledgeBasesPage from "./page.client";

const mockUseKnowledgeBasesPaginated = vi.fn();
const mockUseAllMatchingKnowledgeBases = vi.fn();
const mockUseConnectors = vi.fn();
const mockRestoreMutate = vi.fn();
const mockPurgeMutateAsync = vi.fn();

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBasesPaginated: (params: unknown) =>
    mockUseKnowledgeBasesPaginated(params),
  // By-id query behind the ?edit= deep link; no param in these tests.
  useKnowledgeBase: () => ({ data: undefined }),
  useDeleteKnowledgeBase: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useAllMatchingKnowledgeBases: (...args: unknown[]) =>
    mockUseAllMatchingKnowledgeBases(...args),
  useBulkDeleteKnowledgeBases: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreKnowledgeBase: () => ({
    mutate: mockRestoreMutate,
    isPending: false,
  }),
  usePermanentlyDeleteKnowledgeBase: () => ({
    mutateAsync: mockPurgeMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: (params: unknown) => mockUseConnectors(params),
  // By-id query behind the ?connector= deep link; no param in these tests.
  useConnector: () => ({ data: undefined }),
  useAssignConnectorToKnowledgeBases: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useUnassignConnectorFromKnowledgeBase: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("next/navigation");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/config/config.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

// The status filter reads permissions and URL state of its own; its behavior
// is the shared component's contract, not this page's.
vi.mock("@/components/resource-scope-filter", () => ({
  ResourceDeletedStatusFilter: () => <div>status filter</div>,
}));

vi.mock("@/components/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div>{title}</div> : null,
}));

// Heavy child dialogs, the chat hook, and the create-gate layout chrome are
// out of scope.
vi.mock("./_parts/create-knowledge-base-dialog", () => ({
  CreateKnowledgeBaseDialog: () => null,
}));
vi.mock("./_parts/edit-knowledge-base-dialog", () => ({
  EditKnowledgeBaseDialog: () => null,
}));
vi.mock("./_parts/create-connector-dialog", () => ({
  CreateConnectorDialog: () => null,
}));
vi.mock("./_parts/edit-connector-dialog", () => ({
  EditConnectorDialog: () => null,
}));
vi.mock("./_parts/use-chat-with-knowledge-base", () => ({
  useChatWithKnowledgeBase: () => ({ startChat: vi.fn(), isCreating: false }),
}));
vi.mock("@/app/knowledge/_parts/knowledge-page-layout", () => ({
  KnowledgePageLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
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
    schedule: "0 */6 * * *",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAllMatchingKnowledgeBases.mockReturnValue({
    data: [],
    isFetching: false,
  });
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useFeature).mockReturnValue(
    undefined as ReturnType<typeof useFeature>,
  );
  vi.mocked(useIsGlobalAdmin).mockReturnValue({
    isGlobalAdmin: true,
    isLoading: false,
  });
  vi.mocked(usePathname).mockReturnValue("/knowledge/knowledge-bases");
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
  mockUseKnowledgeBasesPaginated.mockReturnValue({
    data: {
      data: [
        {
          id: "kb-1",
          name: "Handbook",
          description: null,
          connectors: [
            { id: "conn-1", name: "Org Connector", connectorType: "jira" },
            {
              id: "conn-2",
              name: "Synced Connector",
              connectorType: "confluence",
            },
          ],
          totalDocsIndexed: 12,
          assignedAgents: [{ id: "agent-1", name: "Support", agentType: "a" }],
        },
      ],
      pagination: { total: 1 },
    },
    isPending: false,
    isFetching: false,
    isLoadingError: false,
    refetch: vi.fn(),
  });
  mockUseConnectors.mockReturnValue({
    data: [
      makeConnector({ id: "conn-1", name: "Org Connector" }),
      makeConnector({
        id: "conn-2",
        name: "Synced Connector",
        lastSyncStatus: "failed",
      }),
    ],
    isPending: false,
  });
});

describe("KnowledgeBasesPage", () => {
  it("names each knowledge base's connectors on its card, with no row to expand", () => {
    render(<KnowledgeBasesPage />);

    // The connectors used to be one expand-click and a nested table away; the
    // outer row could only say how many there were.
    expect(
      screen.queryByRole("button", { name: "Toggle row" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Org Connector/ })).toHaveAttribute(
      "href",
      "/knowledge/connectors/conn-1?from=knowledge-bases",
    );
    expect(
      screen.getByRole("link", { name: /Synced Connector/ }),
    ).toBeVisible();
    // …alongside what the knowledge base holds and who uses it.
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("documents")).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
  });

  it("keeps the per-connector actions the expandable sub-table used to own", async () => {
    render(<KnowledgeBasesPage />);

    await userEvent.click(screen.getByLabelText("Actions for Org Connector"));

    expect(
      screen.getByRole("menuitem", { name: /Edit connector/ }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Remove from knowledge base/ }),
    );
    expect(screen.getByText("Remove Connector")).toBeInTheDocument();
  });

  it("ticking a knowledge base offers the bulk actions for it", async () => {
    render(<KnowledgeBasesPage />);

    await userEvent.click(screen.getByLabelText("Select Handbook"));

    // Regression: selection state was keyed by row index while the page read
    // it by knowledge base id, so the bar never appeared and bulk delete was
    // unreachable.
    expect(
      screen.getAllByText(/1 knowledge base selected/i).length,
    ).toBeGreaterThan(0);
  });

  it("keeps the bulk bar visible while all matching knowledge bases load", async () => {
    mockUseKnowledgeBasesPaginated.mockReturnValue({
      data: {
        data: [
          {
            id: "kb-1",
            name: "Handbook",
            description: null,
            connectors: [],
            totalDocsIndexed: 0,
            assignedAgents: [],
          },
        ],
        pagination: { total: 2 },
      },
      isPending: false,
      isFetching: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });
    mockUseAllMatchingKnowledgeBases.mockImplementation(
      (_filters: unknown, options?: { enabled?: boolean }) => ({
        data: undefined,
        isFetching: options?.enabled ?? false,
      }),
    );

    render(<KnowledgeBasesPage />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select Handbook" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Select all 2 knowledge bases/i }),
    );

    expect(
      screen
        .getAllByText(/All 2 knowledge bases selected/i)
        .some((element) => element.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
  });

  it("deleted view: rows show how long they have sat in the trash and collapse to Restore + Delete permanently", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("status=deleted") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    const deletedAt = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();
    mockUseKnowledgeBasesPaginated.mockReturnValue({
      data: {
        data: [
          {
            id: "kb-trashed",
            name: "Trashed KB",
            description: null,
            connectors: [],
            totalDocsIndexed: 0,
            assignedAgents: [],
            deletedAt,
          },
        ],
        pagination: { total: 1 },
      },
      isPending: false,
      isFetching: false,
      isLoadingError: false,
      refetch: vi.fn(),
    });

    render(<KnowledgeBasesPage />);

    // Trash metadata: how long the row has sat in the trash.
    expect(screen.getByText(/5 days ago/)).toBeInTheDocument();

    // The connector sub-table is an active-KB surface; no expander in trash.
    expect(
      screen.queryByRole("button", { name: "Toggle row" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/^Restore/));
    expect(mockRestoreMutate).toHaveBeenCalledWith("kb-trashed");

    await userEvent.click(screen.getByLabelText(/^Delete permanently/));
    expect(
      screen.getByText("Delete knowledge base permanently"),
    ).toBeInTheDocument();
  });
});
