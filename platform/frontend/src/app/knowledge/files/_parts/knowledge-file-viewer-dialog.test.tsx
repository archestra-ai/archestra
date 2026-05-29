import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeFileViewerDialog } from "./knowledge-file-viewer-dialog";

vi.mock("@/components/standard-dialog", () => ({
  StandardDialog: ({
    children,
    description,
    footer,
    open,
    title,
  }: {
    children: React.ReactNode;
    description: React.ReactNode;
    footer: React.ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {description}
        {children}
        {footer}
      </div>
    ) : null,
}));

describe("KnowledgeFileViewerDialog", () => {
  it("embeds the content URL without iframe sandboxing", () => {
    render(
      <KnowledgeFileViewerDialog
        file={{
          id: "file-1",
          originalName: "receipt.pdf",
          fileSize: 1024,
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    const frame = screen.getByTitle("receipt.pdf");
    expect(frame).toHaveAttribute("src", "/api/knowledge-files/file-1/content");
    expect(frame).not.toHaveAttribute("sandbox");
  });
});
