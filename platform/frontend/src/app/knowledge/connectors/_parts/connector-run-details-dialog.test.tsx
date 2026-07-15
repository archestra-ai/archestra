import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectorRunDetailsDialog } from "./connector-run-details-dialog";

const mockUseConnectorRun = vi.fn();

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectorRun: (args: unknown) => mockUseConnectorRun(args),
}));

vi.mock(
  "@/app/knowledge/knowledge-bases/_parts/connector-status-badge",
  () => ({
    ConnectorStatusBadge: ({ status }: { status: string }) => (
      <span>{status}</span>
    ),
  }),
);

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/lib/utils", () => ({
  formatDate: ({ date }: { date: string }) => date,
}));

describe("ConnectorRunDetailsDialog", () => {
  it("formats concatenated JSON logs without splitting inside string values", () => {
    mockUseConnectorRun.mockReturnValue({
      data: {
        status: "failed",
        startedAt: "2026-04-06T00:00:00.000Z",
        completedAt: "2026-04-06T00:01:00.000Z",
        documentsProcessed: 1,
        documentsIngested: 0,
        totalItems: 1,
        itemErrors: 1,
        error: "Something failed",
        logs: '{"msg":"value }{ inside string"}{"msg":"next record"}',
      },
    });

    render(
      <ConnectorRunDetailsDialog
        connectorId="connector-1"
        runId="run-1"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Logs")).toBeInTheDocument();
    expect(screen.getByText(/value \}\{ inside string/)).toBeInTheDocument();
    const logBlock = screen.getByText(/next record/).closest("pre");
    expect(logBlock?.textContent).toContain(
      '{"msg":"value }{ inside string"}\n{"msg":"next record"}',
    );
  });

  it("shows the embedding phase for a running content run that finished ingesting", () => {
    // During the embedding drain the Processed count sits frozen at the total,
    // which reads as a hang — the dialog must say ingest is done and embedding
    // is what is still running.
    mockUseConnectorRun.mockReturnValue({
      data: {
        status: "running",
        runType: "content",
        startedAt: "2026-07-13T09:17:38.000Z",
        completedAt: null,
        documentsProcessed: 21650,
        documentsIngested: 21650,
        totalItems: null,
        totalBatches: 433,
        completedBatches: 431,
        logs: null,
      },
    });

    render(
      <ConnectorRunDetailsDialog
        connectorId="connector-1"
        runId="run-1"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Phase:")).toBeInTheDocument();
    expect(screen.getByText("Embedding batch 431/433")).toBeInTheDocument();
  });

  it("shows ACL reconcile stats instead of document counters for a permission run", () => {
    mockUseConnectorRun.mockReturnValue({
      data: {
        status: "success",
        runType: "permission",
        startedAt: "2026-07-08T14:46:36.000Z",
        completedAt: "2026-07-08T14:50:14.000Z",
        documentsProcessed: 0,
        documentsIngested: 0,
        totalItems: null,
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
        logs: null,
      },
    });

    render(
      <ConnectorRunDetailsDialog
        connectorId="connector-1"
        runId="run-1"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Permission Sync Run Details")).toBeInTheDocument();
    expect(screen.getByText("Documents checked:")).toBeInTheDocument();
    expect(
      screen.getByText("Document permissions updated:"),
    ).toBeInTheDocument();
    expect(screen.getByText("13,831")).toBeInTheDocument();
    // Content counters are hidden — they are always 0 for permission runs.
    expect(screen.queryByText("Progress:")).not.toBeInTheDocument();
    expect(screen.queryByText("Ingested:")).not.toBeInTheDocument();
    // The during-backfill note explains partial coverage.
    expect(
      screen.getByText(/only covered documents ingested before it started/),
    ).toBeInTheDocument();
  });
});
