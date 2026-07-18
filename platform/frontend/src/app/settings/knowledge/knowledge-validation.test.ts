import { describe, expect, it } from "vitest";
import { knowledgeSettingsFieldError } from "./knowledge-validation";

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
