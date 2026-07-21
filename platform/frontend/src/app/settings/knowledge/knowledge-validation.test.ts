import { describe, expect, it } from "vitest";
import {
  knowledgeSettingsFieldError,
  saveResultStatuses,
} from "./knowledge-validation";

describe("knowledgeSettingsFieldError", () => {
  it("maps the embedding validation code to the embedding field with its message", () => {
    const error = Object.assign(new Error("Embedding provider unreachable."), {
      internalCode: "embedding_validation_failed",
    });
    expect(knowledgeSettingsFieldError(error)).toEqual({
      field: "embedding",
      message: "Embedding provider unreachable.",
    });
  });

  it("maps the reranker validation code to the reranker field", () => {
    const error = Object.assign(new Error("Reranker credential invalid."), {
      internalCode: "reranker_validation_failed",
    });
    expect(knowledgeSettingsFieldError(error)).toEqual({
      field: "reranker",
      message: "Reranker credential invalid.",
    });
  });

  it("returns null for an unrelated error (handled generically)", () => {
    expect(
      knowledgeSettingsFieldError(
        Object.assign(new Error("boom"), { internalCode: "something_else" }),
      ),
    ).toBeNull();
    expect(knowledgeSettingsFieldError(new Error("boom"))).toBeNull();
    expect(knowledgeSettingsFieldError(null)).toBeNull();
  });
});

describe("saveResultStatuses", () => {
  const embeddingError = Object.assign(new Error("bad embed"), {
    internalCode: "embedding_validation_failed",
  });
  const rerankerError = Object.assign(new Error("bad rerank"), {
    internalCode: "reranker_validation_failed",
  });

  it("marks both configured sections connected on success", () => {
    expect(
      saveResultStatuses({
        error: null,
        embeddingConfigured: true,
        rerankerConfigured: true,
      }),
    ).toEqual({
      embedding: { status: "connected", error: null },
      reranker: { status: "connected", error: null },
    });
  });

  it("leaves an unconfigured (optional) reranker untested on success", () => {
    const result = saveResultStatuses({
      error: null,
      embeddingConfigured: true,
      rerankerConfigured: false,
    });
    expect(result.reranker.status).toBe("untested");
  });

  it("marks embedding failed and reranker untested (not reached) on an embedding failure", () => {
    expect(
      saveResultStatuses({
        error: embeddingError,
        embeddingConfigured: true,
        rerankerConfigured: true,
      }),
    ).toEqual({
      embedding: { status: "failed", error: "bad embed" },
      reranker: { status: "untested", error: null },
    });
  });

  it("marks embedding connected (validated first) and reranker failed on a reranker failure", () => {
    expect(
      saveResultStatuses({
        error: rerankerError,
        embeddingConfigured: true,
        rerankerConfigured: true,
      }),
    ).toEqual({
      embedding: { status: "connected", error: null },
      reranker: { status: "failed", error: "bad rerank" },
    });
  });

  it("leaves both untested on a non-field error", () => {
    const result = saveResultStatuses({
      error: new Error("500"),
      embeddingConfigured: true,
      rerankerConfigured: true,
    });
    expect(result.embedding.status).toBe("untested");
    expect(result.reranker.status).toBe("untested");
  });
});
