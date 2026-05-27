import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FileStatusBadge } from "./connector-files-section";

describe("FileStatusBadge", () => {
  it("shows embedding error details in a tooltip for failed indexing", async () => {
    render(
      <FileStatusBadge
        embeddingStatus="failed"
        embeddingError="Embedding dimensions mismatch. Configure a model with 1536 dimensions."
      />,
    );

    await userEvent.hover(screen.getByText("Failed"));

    expect(
      await screen.findAllByText(
        "Embedding dimensions mismatch. Configure a model with 1536 dimensions.",
      ),
    ).not.toHaveLength(0);
  });

  it("keeps processing errors on the extraction status tooltip", async () => {
    render(
      <FileStatusBadge
        processingStatus="failed"
        processingError="Unable to extract text from this file."
        embeddingStatus="pending"
        embeddingError="Embedding failed"
      />,
    );

    await userEvent.hover(screen.getByText("Processing Failed"));

    expect(
      await screen.findAllByText("Unable to extract text from this file."),
    ).not.toHaveLength(0);
    expect(screen.queryByText("Embedding failed")).not.toBeInTheDocument();
  });
});
