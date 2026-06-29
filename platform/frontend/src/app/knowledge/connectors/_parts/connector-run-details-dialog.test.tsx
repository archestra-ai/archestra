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
});
