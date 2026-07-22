import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mock handles (referenced inside the module factories below) ---
const {
  mockUseConnector,
  mockUseConnectorRuns,
  mockUseConnectorKnowledgeBases,
  mockUseConnectorPermissionCoverage,
  mockTriggerPermissionSyncMutate,
} = vi.hoisted(() => ({
  mockUseConnector: vi.fn(),
  mockUseConnectorRuns: vi.fn(),
  mockUseConnectorKnowledgeBases: vi.fn(),
  mockUseConnectorPermissionCoverage: vi.fn(),
  mockTriggerPermissionSyncMutate: vi.fn(),
}));

const noopMutation = () => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
});

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnector: (id: string) => mockUseConnector(id),
  useConnectorRun: () => ({ data: null }),
  useConnectorRuns: (params: unknown) => mockUseConnectorRuns(params),
  useConnectorKnowledgeBases: (id: string) =>
    mockUseConnectorKnowledgeBases(id),
  useConnectorPermissionCoverage: (params: unknown) =>
    mockUseConnectorPermissionCoverage(params),
  useTriggerPermissionSync: () => ({
    mutate: mockTriggerPermissionSyncMutate,
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useSyncConnector: () => noopMutation(),
  useForceResyncConnector: () => noopMutation(),
  useTestConnectorConnection: () => noopMutation(),
  useAssignConnectorToKnowledgeBases: () => noopMutation(),
  useUnassignConnectorFromKnowledgeBase: () => noopMutation(),
}));

vi.mock("@/lib/knowledge/knowledge-base.query", () => ({
  useKnowledgeBases: () => ({ data: [], isPending: false }),
}));

const mockUseFeature = vi.fn();
vi.mock("@/lib/config/config.query", () => ({
  useFeature: (flag: string) => mockUseFeature(flag),
}));

// Heavy child dialogs/tables are out of scope for these behavior tests.
vi.mock(
  "@/app/knowledge/connectors/_parts/connector-run-details-dialog",
  () => ({ ConnectorRunDetailsDialog: () => null }),
);
vi.mock("@/app/knowledge/connectors/_parts/connector-documents-table", () => ({
  ConnectorDocumentsTable: () => null,
}));
vi.mock(
  "@/app/knowledge/connectors/_parts/connector-user-groups-table",
  () => ({ ConnectorUserGroupsTable: () => <div>groups-table</div> }),
);
vi.mock("@/app/knowledge/connectors/_parts/connector-members-table", () => ({
  ConnectorMembersTable: () => <div>members-table</div>,
}));
vi.mock(
  "@/app/knowledge/connectors/_parts/connector-unassigned-users-alert",
  () => ({
    ConnectorUnassignedUsersAlert: () => <div>unassigned-alert</div>,
  }),
);
vi.mock("@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog", () => ({
  EditConnectorDialog: () => null,
}));

vi.mock("next/navigation");

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import ConnectorDetailPage from "./page.client";

const CONNECTOR_ID = "conn-1";

function makeConnector(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CONNECTOR_ID,
    name: "My Connector",
    description: null,
    connectorType: "google-drive",
    visibility: "org-wide",
    enabled: true,
    lastSyncStatus: "success",
    lastSyncAt: null,
    totalDocsIngested: 0,
    schedule: null,
    lastPermissionSyncAt: null,
    permissionSyncIntervalSeconds: 1800,
    ...overrides,
  };
}

function setSearchParams(params: Record<string, string>) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(params) as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usePathname).mockReturnValue(
    `/knowledge/connectors/${CONNECTOR_ID}`,
  );
  vi.mocked(useRouter).mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  setSearchParams({});
  mockUseConnector.mockReturnValue({
    data: makeConnector(),
    isPending: false,
    isLoadingError: false,
    refetch: vi.fn(),
  });
  mockUseConnectorRuns.mockReturnValue({ data: null, isPending: false });
  mockUseConnectorKnowledgeBases.mockReturnValue({
    data: { data: [] },
    isPending: false,
  });
  mockUseConnectorPermissionCoverage.mockReturnValue({ data: null });
  // Auto-sync permissions is beta-gated; default the suite to the flag on.
  mockUseFeature.mockReturnValue(true);
});

describe("ConnectorDetailPage", () => {
  describe("Permission Sync Runs tab visibility", () => {
    it("shows one merged Sync Runs tab with a run-family filter for auto-sync connectors", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // No separate permission-runs tab: one Sync Runs tab covers both
      // families, narrowed by the in-tab filter.
      expect(
        screen.queryByRole("link", { name: "Permission Sync Runs" }),
      ).not.toBeInTheDocument();
      // PageLayout renders the tab list twice (desktop + mobile), so each label
      // appears more than once; assert on the first match.
      expect(
        screen.getAllByRole("link", { name: "Sync Runs" }).length,
      ).toBeGreaterThan(0);
      // The run-family filter follows the standard dropdown-filter pattern.
      expect(
        screen.getByRole("combobox", { name: "Filter runs" }),
      ).toBeInTheDocument();
      // The permission views are split into a Users tab (resolution +
      // manual mapping) and a Groups tab (the group snapshot).
      const usersTabs = screen.getAllByRole("link", { name: "Users" });
      expect(usersTabs.length).toBeGreaterThan(0);
      expect(usersTabs[0]).toHaveAttribute(
        "href",
        `/knowledge/connectors/${CONNECTOR_ID}?tab=users`,
      );
      const groupsTabs = screen.getAllByRole("link", { name: "Groups" });
      expect(groupsTabs.length).toBeGreaterThan(0);
      expect(groupsTabs[0]).toHaveAttribute(
        "href",
        `/knowledge/connectors/${CONNECTOR_ID}?tab=groups`,
      );
    });

    it("renders the Users table on the Users tab and the Groups table on the Groups tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      setSearchParams({ tab: "users" });
      const { unmount } = render(
        <ConnectorDetailPage connectorId={CONNECTOR_ID} />,
      );
      expect(screen.getByText("members-table")).toBeInTheDocument();
      expect(screen.queryByText("groups-table")).not.toBeInTheDocument();
      unmount();

      setSearchParams({ tab: "groups" });
      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);
      expect(screen.getByText("groups-table")).toBeInTheDocument();
      expect(screen.queryByText("members-table")).not.toBeInTheDocument();
    });

    it("shows the unassigned-users alert on every tab of an auto-sync connector", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      // Sync Runs tab (default).
      const { unmount } = render(
        <ConnectorDetailPage connectorId={CONNECTOR_ID} />,
      );
      expect(screen.getByText("unassigned-alert")).toBeInTheDocument();
      unmount();

      // Documents tab too — the problem surfaces without drilling down.
      setSearchParams({ tab: "documents" });
      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);
      expect(screen.getByText("unassigned-alert")).toBeInTheDocument();
    });

    it("lands legacy Permissions-tab deep links on the Users tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permissions" });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("members-table")).toBeInTheDocument();
    });

    it("hides the Users and Groups tabs for an auto-sync connector when the beta flag is off", () => {
      mockUseFeature.mockReturnValue(false);
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.queryAllByRole("link", { name: "Users" })).toHaveLength(0);
      expect(screen.queryAllByRole("link", { name: "Groups" })).toHaveLength(0);
      // The run-family filter is a permission-only affordance too.
      expect(
        screen.queryByRole("combobox", { name: "Filter runs" }),
      ).not.toBeInTheDocument();
    });

    it("hides the permission tabs for non-auto-sync connectors", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "org-wide" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.queryAllByRole("link", { name: "Users" })).toHaveLength(0);
      expect(screen.queryAllByRole("link", { name: "Groups" })).toHaveLength(0);
      expect(
        screen.getAllByRole("link", { name: "Sync Runs" }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("useConnectorRuns runType wiring", () => {
    it("requests content runs on the default Sync Runs tab", () => {
      setSearchParams({});
      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(mockUseConnectorRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorId: CONNECTOR_ID,
          runType: "content",
        }),
      );
    });

    it("requests permission runs on the Permission Sync Runs tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(mockUseConnectorRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorId: CONNECTOR_ID,
          runType: "permission",
        }),
      );
    });

    it("shows the embedding phase with batch progress for a draining content run", () => {
      // totalBatches is only set once the ingest loop finishes, so a running
      // run with it set is draining embeddings — the frozen Processed count
      // must not read as a hang.
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-1",
              connectorId: CONNECTOR_ID,
              status: "running",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: null,
              documentsProcessed: 22915,
              documentsIngested: 22915,
              totalItems: 22915,
              totalBatches: 459,
              completedBatches: 324,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("Embedding batch 324/459")).toBeInTheDocument();
      // One step at a time: the running row shows only the current step, not
      // the frozen ingest counters.
      expect(screen.queryByText(/processed/)).not.toBeInTheDocument();
    });

    it("shows the ingesting phase for a running content run before batches are set", () => {
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-2",
              connectorId: CONNECTOR_ID,
              status: "running",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: null,
              documentsProcessed: 120,
              documentsIngested: 120,
              totalItems: 500,
              totalBatches: null,
              completedBatches: null,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText("Ingesting documents 120/500"),
      ).toBeInTheDocument();
    });

    it("keeps the live processed counter when no total estimate is available", () => {
      // The upstream count estimate can fail or lag; the counter must still
      // tick, or a long ingest reads as stuck.
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-2b",
              connectorId: CONNECTOR_ID,
              status: "running",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: null,
              documentsProcessed: 7850,
              documentsIngested: 0,
              totalItems: null,
              totalBatches: null,
              completedBatches: null,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText("Ingesting documents · 7,850 processed"),
      ).toBeInTheDocument();
    });

    it("shows no phase line for completed runs", () => {
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-3",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: "2026-07-08T11:00:00Z",
              documentsProcessed: 500,
              documentsIngested: 500,
              totalItems: 500,
              totalBatches: 10,
              completedBatches: 10,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.queryByText(/embedding batch/i)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/ingesting documents/i),
      ).not.toBeInTheDocument();
      // A completed documents run reads as an outcome — what landed, not the
      // progress counters.
      expect(screen.getByRole("table")).toHaveTextContent("500 ingested");
      expect(screen.queryByText(/processed/)).not.toBeInTheDocument();
    });

    it("renders a synthetic Queued row and disables Sync Now while a sync is enqueued", () => {
      // An enqueued sync has no run row yet — without the synthetic row the
      // table shows nothing and the disabled button reads as a dead click.
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [],
          queued: { content: true, permission: false },
          pagination: { total: 0 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("Queued")).toBeInTheDocument();
      expect(screen.getByText("Waiting for a worker…")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Queued\.\.\./ }),
      ).toBeDisabled();
    });

    it("renders a completed documents run that ingested nothing as 'No changes'", () => {
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-4",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "content",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: "2026-07-08T10:00:02Z",
              documentsProcessed: 1,
              documentsIngested: 0,
              totalItems: 1,
              totalBatches: 0,
              completedBatches: 0,
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("No changes")).toBeInTheDocument();
      expect(screen.queryByText(/ingested/)).not.toBeInTheDocument();
    });

    it("summarizes permission-run stats and the during-content-sync badge via the legacy permission-runs link", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "prun-1",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "permission",
              startedAt: "2026-07-08T14:46:36Z",
              completedAt: "2026-07-08T14:50:14Z",
              documentsProcessed: 0,
              documentsIngested: 0,
              stats: {
                totalDocs: 22915,
                docsScanned: 22915,
                aclsChanged: 13831,
                chunksRewritten: 14000,
                failClosed: 3,
                groupsSynced: 6,
                membershipsUpserted: 6,
                contentSyncActiveDuringRun: true,
              },
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // The legacy permission-runs deep link preselects the family filter —
      // observable through the runs query it drives (the closed Radix Select
      // does not render its selected label in jsdom).
      expect(mockUseConnectorRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ runType: "permission" }),
      );
      // Family-aware Results summary instead of dedicated permission columns:
      // a full reconcile renders the complete counter listing (no mode label).
      const runsTable = screen.getByRole("table");
      expect(runsTable).toHaveTextContent(
        "22,915 docs checked · 13,831 permissions updated",
      );
      expect(screen.getByText("3 docs locked")).toBeInTheDocument();
      expect(runsTable).toHaveTextContent("6 groups checked");
      expect(runsTable).toHaveTextContent("6 group members updated");
      // No qualifier badge in the row — the ran-during-a-content-sync note
      // lives only in the run details dialog.
      expect(
        screen.queryByText("during documents sync"),
      ).not.toBeInTheDocument();
    });

    it("renders a clean delta permission run as 'No changes'", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "prun-2",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "permission",
              startedAt: "2026-07-08T15:46:36Z",
              completedAt: "2026-07-08T15:46:40Z",
              documentsProcessed: 0,
              documentsIngested: 0,
              stats: {
                mode: "delta",
                totalDocs: 22915,
                docsScanned: 0,
                aclsChanged: 0,
                chunksRewritten: 0,
                failClosed: 0,
                groupsSynced: 0,
                membershipsUpserted: 0,
                contentSyncActiveDuringRun: false,
              },
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // A probe-driven no-op is the ideal outcome, not a "0 checked" failure.
      expect(screen.getByText("No changes")).toBeInTheDocument();
      expect(screen.queryByText(/permissions updated/)).not.toBeInTheDocument();
      expect(screen.queryByText(/docs checked/)).not.toBeInTheDocument();
    });

    it("a RUNNING permission run renders live counters, never a premature 'no changes' verdict", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "prun-5",
              connectorId: CONNECTOR_ID,
              status: "running",
              runType: "permission",
              startedAt: "2026-07-08T18:46:36Z",
              completedAt: null,
              documentsProcessed: 0,
              documentsIngested: 0,
              // Zero counters mid-run mean "no progress persisted yet" —
              // the pass may be mid audience verification with its outcome
              // entirely unknown.
              stats: {
                mode: "delta",
                totalDocs: 22915,
                docsScanned: 0,
                aclsChanged: 0,
                chunksRewritten: 0,
                failClosed: 0,
                groupsSynced: 0,
                membershipsUpserted: 0,
                contentSyncActiveDuringRun: false,
              },
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // Zero counters render as live progress — the same pattern as a
      // running documents run — with the scanned total as the denominator.
      expect(screen.getByRole("table")).toHaveTextContent(
        "0 / 22,915 docs checked · 0 permissions updated",
      );
      expect(screen.queryByText("No changes")).not.toBeInTheDocument();
    });

    it("surfaces a membership-only change — an upstream group removal must not read as 'no changes'", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "prun-4",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "permission",
              startedAt: "2026-07-08T17:46:36Z",
              completedAt: "2026-07-08T17:46:45Z",
              documentsProcessed: 0,
              documentsIngested: 0,
              stats: {
                mode: "delta",
                totalDocs: 22915,
                docsScanned: 0,
                aclsChanged: 0,
                chunksRewritten: 0,
                failClosed: 0,
                groupsSynced: 14,
                membershipsUpserted: 0,
                membershipsRemoved: 2,
                contentSyncActiveDuringRun: false,
              },
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.queryByText("No changes")).not.toBeInTheDocument();
      expect(screen.getByRole("table")).toHaveTextContent(
        "2 group members removed",
      );
      // A settled delta run reads as an outcome — only what changed, no
      // counter listing.
      expect(screen.queryByText(/docs checked/)).not.toBeInTheDocument();
    });

    it("surfaces a container-audience-only change — one audience row rewritten, zero document ACL writes", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "prun-3",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "permission",
              startedAt: "2026-07-08T16:46:36Z",
              completedAt: "2026-07-08T16:50:14Z",
              documentsProcessed: 0,
              documentsIngested: 0,
              stats: {
                mode: "full",
                totalDocs: 22915,
                docsScanned: 22915,
                aclsChanged: 0,
                containersSynced: 19,
                containersChanged: 1,
                chunksRewritten: 0,
                failClosed: 0,
                groupsSynced: 6,
                membershipsUpserted: 0,
                contentSyncActiveDuringRun: false,
              },
            },
          ],
          pagination: { total: 1 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // The audience row IS the change (documents reference it by token), so
      // an upstream permission edit must not read as "nothing happened".
      const runsTable = screen.getByRole("table");
      expect(runsTable).toHaveTextContent("1 access list updated");
      expect(runsTable).toHaveTextContent("0 permissions updated");
    });

    it("shows awaiting-sync coverage in the metadata block and triggers a manual sync from the actions menu", async () => {
      const { userEvent } = await import("@testing-library/user-event").then(
        (m) => ({ userEvent: m.default.setup() }),
      );
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 100,
          failClosedDocuments: 40,
          permissionSyncRunning: false,
          nextScheduledAt: "2026-07-08T16:00:00Z",
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("Permissions Coverage")).toBeInTheDocument();
      expect(
        screen.getByText(/40 documents awaiting permission sync/),
      ).toBeInTheDocument();
      // The permissions row mirrors the content row's Last/cadence items.
      expect(screen.getByText("Last Permissions Sync")).toBeInTheDocument();
      expect(screen.getByText("Every 30 minutes")).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Connector actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: /Sync Permissions Now/ }),
      );
      expect(mockTriggerPermissionSyncMutate).toHaveBeenCalledWith(
        CONNECTOR_ID,
      );
    });

    it("renders no coverage item at all when no documents are fail-closed (exception-only)", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 22915,
          failClosedDocuments: 0,
          permissionSyncRunning: false,
          nextScheduledAt: null,
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // Full coverage is the self-healing steady state — showing it is noise.
      expect(
        screen.queryByText("Permissions Coverage"),
      ).not.toBeInTheDocument();
      // The symmetric permissions items still render.
      expect(screen.getByText("Last Permissions Sync")).toBeInTheDocument();
    });

    it("shows Syncing now and disables the menu item while a pass runs", async () => {
      const { userEvent } = await import("@testing-library/user-event").then(
        (m) => ({ userEvent: m.default.setup() }),
      );
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 100,
          failClosedDocuments: 0,
          permissionSyncRunning: true,
          nextScheduledAt: "2026-07-08T16:00:00Z",
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(screen.getByText("Syncing now…")).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Connector actions" }),
      );
      const item = await screen.findByRole("menuitem", {
        name: /Permissions syncing…/,
      });
      expect(item).toHaveAttribute("aria-disabled", "true");
    });

    it("hides permission coverage and the sync menu item for non-auto-sync connectors", async () => {
      const { userEvent } = await import("@testing-library/user-event").then(
        (m) => ({ userEvent: m.default.setup() }),
      );
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "org-wide" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      mockUseConnectorPermissionCoverage.mockReturnValue({
        data: {
          totalDocuments: 100,
          failClosedDocuments: 40,
          permissionSyncRunning: false,
          nextScheduledAt: null,
        },
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.queryByText("Permissions Coverage"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/awaiting sync/)).not.toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: "Connector actions" }),
      );
      expect(
        screen.queryByRole("menuitem", { name: /Sync Permissions/ }),
      ).not.toBeInTheDocument();
    });

    it("shows the permission-specific empty state on the Permission Sync Runs tab", () => {
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: { data: [], pagination: { total: 0 } },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      expect(
        screen.getByText(/No permission sync runs yet/),
      ).toBeInTheDocument();
    });

    it("requests runs filtered by status when the status filter changes", async () => {
      window.HTMLElement.prototype.hasPointerCapture = vi.fn();
      window.HTMLElement.prototype.setPointerCapture = vi.fn();
      window.HTMLElement.prototype.releasePointerCapture = vi.fn();
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
      const { userEvent } = await import("@testing-library/user-event").then(
        (m) => ({ userEvent: m.default.setup() }),
      );

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      await userEvent.click(
        screen.getByRole("combobox", { name: "Filter by status" }),
      );
      await userEvent.click(
        await screen.findByRole("option", { name: "Failed" }),
      );

      expect(mockUseConnectorRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("refetches runs with the new limit when rows-per-page changes", async () => {
      // Radix Select relies on pointer-capture + scrollIntoView, which jsdom
      // does not implement.
      window.HTMLElement.prototype.hasPointerCapture = vi.fn();
      window.HTMLElement.prototype.setPointerCapture = vi.fn();
      window.HTMLElement.prototype.releasePointerCapture = vi.fn();
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
      const { userEvent } = await import("@testing-library/user-event").then(
        (m) => ({ userEvent: m.default.setup() }),
      );
      mockUseConnector.mockReturnValue({
        data: makeConnector({ visibility: "auto-sync-permissions" }),
        isPending: false,
        isLoadingError: false,
        refetch: vi.fn(),
      });
      setSearchParams({ tab: "permission-runs" });
      mockUseConnectorRuns.mockReturnValue({
        data: {
          data: [
            {
              id: "run-1",
              connectorId: CONNECTOR_ID,
              status: "success",
              runType: "permission",
              startedAt: "2026-07-08T10:00:00Z",
              completedAt: "2026-07-08T10:05:00Z",
              stats: null,
            },
          ],
          pagination: { total: 30 },
        },
        isPending: false,
      });

      render(<ConnectorDetailPage connectorId={CONNECTOR_ID} />);

      // Pick 20 in the rows-per-page selector (first of the desktop/mobile
      // pair, excluding every toolbar filter combobox).
      const rowsPerPage = screen
        .getAllByRole("combobox")
        .filter((el) => !el.getAttribute("aria-label")?.startsWith("Filter"));
      await userEvent.click(rowsPerPage[0]);
      await userEvent.click(await screen.findByRole("option", { name: "20" }));

      expect(mockUseConnectorRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ limit: 20, offset: 0 }),
      );
    });
  });
});
