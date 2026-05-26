import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorFilesSection } from "./connector-files-section";

const connectorFilesMocks = vi.hoisted(() => ({
  useConnectorFile: vi.fn(),
  useConnectorFilesPaginated: vi.fn(),
  useDeleteConnectorFile: vi.fn(),
  useUploadConnectorFiles: vi.fn(),
}));

vi.mock("@/components/ui/data-table", () => ({
  DataTable: ({
    columns,
    data,
  }: {
    columns: Array<{
      id?: string;
      accessorKey?: string;
      cell?: (context: {
        row: { original: Record<string, unknown> };
      }) => ReactNode;
    }>;
    data: Array<Record<string, unknown>>;
  }) => (
    <table>
      <tbody>
        {data.map((row) => (
          <tr key={String(row.id)}>
            {columns.map((column) => (
              <td key={column.id ?? column.accessorKey}>
                {typeof column.cell === "function"
                  ? column.cell({ row: { original: row } })
                  : String(row[column.accessorKey ?? ""] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/knowledge/connector-files.query", () => ({
  formatFileSize: (bytes: number) => `${bytes} B`,
  useConnectorFile: connectorFilesMocks.useConnectorFile,
  useConnectorFilesPaginated: connectorFilesMocks.useConnectorFilesPaginated,
  useDeleteConnectorFile: connectorFilesMocks.useDeleteConnectorFile,
  useUploadConnectorFiles: connectorFilesMocks.useUploadConnectorFiles,
}));

const baseFile = {
  id: "file-1",
  connectorId: "connector-1",
  originalName: "broken.txt",
  mimeType: "text/plain",
  fileSize: 42,
  contentHash: "hash",
  createdAt: "2026-05-25T00:00:00.000Z",
  processingStatus: "completed",
  processingError: null,
  embeddingStatus: "completed",
  embeddingError: null,
};

describe("ConnectorFilesSection", () => {
  beforeEach(() => {
    connectorFilesMocks.useConnectorFile.mockReturnValue({ data: null });
    connectorFilesMocks.useDeleteConnectorFile.mockReturnValue({
      mutateAsync: vi.fn(),
    });
    connectorFilesMocks.useUploadConnectorFiles.mockReturnValue({
      mutateAsync: vi.fn(),
    });
  });

  it("shows a compact tooltip for failed embedding rows with embeddingError", () => {
    connectorFilesMocks.useConnectorFilesPaginated.mockReturnValue({
      data: {
        data: [
          {
            ...baseFile,
            embeddingStatus: "failed",
            embeddingError: "dimensions_mismatch",
          },
        ],
        pagination: { total: 1 },
      },
      isPending: false,
      isFetching: false,
    });

    render(<ConnectorFilesSection connectorId="connector-1" />);

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Failed: The embedding model returned vectors/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/do not match the configured database column/),
    ).toBeInTheDocument();
  });

  it("keeps processingError visible in the processing failure tooltip", () => {
    connectorFilesMocks.useConnectorFilesPaginated.mockReturnValue({
      data: {
        data: [
          {
            ...baseFile,
            processingStatus: "failed",
            processingError: "Text extraction failed",
            embeddingStatus: "pending",
          },
        ],
        pagination: { total: 1 },
      },
      isPending: false,
      isFetching: false,
    });

    render(<ConnectorFilesSection connectorId="connector-1" />);

    expect(
      screen.getByRole("button", {
        name: "Processing Failed: Text extraction failed",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Text extraction failed")).toBeInTheDocument();
  });
});
