import { describe, expect, test } from "vitest";
import type { MemoryItem } from "@/types/memory-item";
import { applyBudget, estimateTokenCount } from "./injection-budget";

describe("estimateTokenCount", () => {
  test("returns zero for empty content", () => {
    expect(estimateTokenCount("")).toBe(0);
    expect(estimateTokenCount("   ")).toBe(0);
  });

  test("uses chars/4 approximation", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcde")).toBe(2);
    expect(estimateTokenCount("12345678")).toBe(2);
  });
});

describe("applyBudget", () => {
  test("applies top-k first", () => {
    const result = applyBudget({
      items: [
        makeItem("1", "small"),
        makeItem("2", "small"),
        makeItem("3", "small"),
      ],
      maxTokens: 100,
      topK: 2,
    });

    expect(result.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(result.droppedByTopK).toBe(1);
  });

  test("enforces token budget in sorted order", () => {
    const result = applyBudget({
      items: [
        makeItem("1", "a".repeat(40)),
        makeItem("2", "b".repeat(40)),
        makeItem("3", "c".repeat(40)),
      ],
      maxTokens: 22,
      topK: 3,
    });

    expect(result.items.map((item) => item.id)).toEqual(["1"]);
    expect(result.totalTokensApprox).toBeGreaterThan(0);
    expect(result.droppedByBudget).toBe(2);
  });
});

// ============================================================================
// Internal helpers
// ============================================================================

function makeItem(id: string, content: string): MemoryItem {
  const now = new Date();

  return {
    id,
    organizationId: "org-1",
    scopeType: "user",
    scopeId: "user-1",
    kind: "preference",
    status: "approved",
    content,
    createdBy: "user-1",
    reviewedBy: "user-1",
    reviewedAt: now,
    rejectionReason: null,
    rejectionComment: null,
    extractorVersion: null,
    policyFlags: [],
    sourceType: null,
    sourceId: null,
    sourceMetadata: null,
    sourceConversationId: null,
    sourceMessageIds: null,
    supersedesMemoryId: null,
    confidenceBand: null,
    language: null,
    scores: null,
    classifications: null,
    scorerVersion: null,
    lastRetrievedAt: null,
    retrievalCount: 0,
    lastVerifiedAt: now,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
