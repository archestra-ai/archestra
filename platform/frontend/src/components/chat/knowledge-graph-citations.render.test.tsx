import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeGraphCitations } from "./knowledge-graph-citations";

vi.mock("@/app/knowledge/files/_parts/knowledge-file-viewer-dialog", () => ({
  KnowledgeFileViewerDialog: ({
    file,
    open,
  }: {
    file: { id: string; originalName: string };
    open: boolean;
  }) => (open ? <div role="dialog">viewer:{file.id}</div> : null),
}));

describe("KnowledgeGraphCitations", () => {
  it("opens the Knowledge File viewer for uploaded file citations", () => {
    render(
      <KnowledgeGraphCitations
        parts={[
          {
            type: "dynamic-tool",
            toolName: "archestra__query_knowledge_sources",
            state: "output-available",
            output: {
              results: [
                {
                  citation: {
                    title: "Uploaded source",
                    connectorType: "file_upload",
                    documentId: "document-id",
                    sourceId: "knowledge-file-id",
                    sourceUrl: null,
                  },
                },
              ],
            },
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Uploaded source/i }));

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "viewer:knowledge-file-id",
    );
  });
});
