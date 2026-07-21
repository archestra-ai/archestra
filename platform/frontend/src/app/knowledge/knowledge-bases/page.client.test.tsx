import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTeams } from "@/lib/teams/team.query";
import KnowledgeBasesPage from "./page.client";

const mockUseKnowledgeBasesPaginated = vi.fn();
const mockUseConnectors = vi.fn();

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBasesPaginated: (params: unknown) =>
    mockUseKnowledgeBasesPaginated(params),
  // By-id query behind the ?edit= deep link; no param in these tests.
  useKnowledgeBase: () => ({ data: undefined }),
  useDeleteKnowledgeBase: () => ({
    mutateAsync: vi.fn(),
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
          connectors: [],
          totalDocsIndexed: 12,
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
      makeConnector({ name: "Org Connector", visibility: "org-wide" }),
      makeConnector({
        name: "Synced Connector",
        visibility: "auto-sync-permissions",
      }),
    ],
    isPending: false,
  });
});

describe("KnowledgeBasesPage", () => {
  it("shows the expanded connectors with access scope and schedule, like the connectors page", async () => {
    render(<KnowledgeBasesPage />);

    await userEvent.click(screen.getByRole("button", { name: "Toggle row" }));

    // The sub-table carries the connectors-page columns, including who can
    // retrieve each connector's documents. The badge language itself is the
    // connectors page's contract — pinned there, not re-asserted here.
    expect(screen.getByText("Accessible to")).toBeInTheDocument();
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByText("Org Connector")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.getAllByText(/Every 6 hours/i).length).toBeGreaterThan(0);
  });
});
