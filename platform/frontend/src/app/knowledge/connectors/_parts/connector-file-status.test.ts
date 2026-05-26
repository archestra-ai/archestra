import { describe, expect, it } from "vitest";
import {
  getConnectorFileStatusMeta,
  getEmbeddingErrorMessage,
} from "./connector-file-status";

describe("connector-file-status", () => {
  it("prefers processing failures over embedding status", () => {
    expect(
      getConnectorFileStatusMeta({
        processingStatus: "failed",
        embeddingStatus: "failed",
        processingError: "Could not extract text from PDF",
        embeddingError: "rate_limited",
      }),
    ).toEqual({
      label: "Processing Failed",
      tooltip: "Could not extract text from PDF",
      variant: "destructive",
    });
  });

  it("maps failed embedding status to a descriptive tooltip", () => {
    expect(
      getConnectorFileStatusMeta({
        embeddingStatus: "failed",
        embeddingError: "rate_limited",
      }),
    ).toEqual({
      label: "Indexing Failed",
      tooltip: getEmbeddingErrorMessage("rate_limited"),
      variant: "destructive",
    });
  });

  it("shows spinner metadata for indexing", () => {
    expect(
      getConnectorFileStatusMeta({
        embeddingStatus: "processing",
      }),
    ).toEqual({
      label: "Indexing...",
      tooltip: "Generating embeddings for this file.",
      variant: "secondary",
      showSpinner: true,
    });
  });
});
