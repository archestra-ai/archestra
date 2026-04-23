import { context, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import type { MemoryItem } from "@/types/memory-item";
import { build } from "./injection-builder";

const mockListForInjection = vi.hoisted(() => vi.fn());

vi.mock("@/memory/retrieval/retrieval-service", () => ({
  listForInjection: mockListForInjection,
}));

describe("memory injection builder", () => {
  const originalTokenBudget = config.memory.injectionTokenBudget;
  const originalTopK = config.memory.injectionTopK;
  const setAttribute = vi.fn();

  beforeEach(() => {
    config.memory.injectionTokenBudget = 600;
    config.memory.injectionTopK = 10;
    mockListForInjection.mockReset();
    setAttribute.mockReset();

    vi.spyOn(context, "active").mockReturnValue({} as never);
    vi.spyOn(trace, "getSpan").mockReturnValue({
      setAttribute,
    } as never);
  });

  afterEach(() => {
    config.memory.injectionTokenBudget = originalTokenBudget;
    config.memory.injectionTopK = originalTopK;
    vi.restoreAllMocks();
  });

  test("returns null without querying memory when disabled", async () => {
    const result = await build({
      userId: "user-1",
      organizationId: "org-1",
      enabled: false,
    });

    expect(result).toBeNull();
    expect(mockListForInjection).not.toHaveBeenCalled();
    expect(setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_count",
      0,
    );
    expect(setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_tokens_approx",
      0,
    );
  });

  test("returns formatted durable memory block when enabled", async () => {
    config.memory.injectionTopK = 1;
    mockListForInjection.mockResolvedValue([
      makeItem("1", "  Loves   concise answers "),
      makeItem("2", "Uses keyboard shortcuts"),
    ]);

    const result = await build({
      userId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      enabled: true,
    });

    expect(mockListForInjection).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      scopesEnabled: ["user"],
    });
    expect(result).toContain("<durable_memory>");
    expect(result).toContain("[preference] Loves concise answers");
    expect(result).not.toContain("Uses keyboard shortcuts");
    expect(setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_count",
      1,
    );

    const tokensCall = setAttribute.mock.calls.find(
      ([key]) => key === "archestra.memory.injected_tokens_approx",
    );
    expect(tokensCall).toBeDefined();
    expect(tokensCall?.[1]).toBeGreaterThan(0);
  });

  test("falls back to null when retrieval fails", async () => {
    mockListForInjection.mockRejectedValue(new Error("db unavailable"));

    const result = await build({
      userId: "user-1",
      organizationId: "org-1",
      enabled: true,
    });

    expect(result).toBeNull();
    expect(setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_count",
      0,
    );
    expect(setAttribute).toHaveBeenCalledWith(
      "archestra.memory.injected_tokens_approx",
      0,
    );
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
    sourceConversationId: null,
    sourceMessageIds: null,
    supersedesMemoryId: null,
    confidenceBand: null,
    language: null,
    lastVerifiedAt: now,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
