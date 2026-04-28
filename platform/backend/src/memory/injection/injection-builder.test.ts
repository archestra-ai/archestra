import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MemoryItem } from "@/types/memory-item";
import { build } from "./injection-builder";

const mockListForInjection = vi.hoisted(() => vi.fn());
const mockGetOrganizationById = vi.hoisted(() => vi.fn());

vi.mock("@/memory/retrieval/retrieval-service", () => ({
  listForInjection: mockListForInjection,
}));

vi.mock("@/models", () => ({
  OrganizationModel: {
    getById: mockGetOrganizationById,
  },
}));

describe("memory injection builder", () => {
  const setAttribute = vi.fn();

  beforeEach(() => {
    mockListForInjection.mockReset();
    mockGetOrganizationById.mockReset();
    setAttribute.mockReset();

    mockGetOrganizationById.mockResolvedValue({
      id: "org-1",
      memoryInjectionTopK: 10,
      memoryInjectionTokenBudget: 600,
    });

    vi.spyOn(context, "active").mockReturnValue(ROOT_CONTEXT);
    vi.spyOn(trace, "getSpan").mockReturnValue({
      setAttribute,
    } as never);
  });

  afterEach(() => {
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
    mockGetOrganizationById.mockResolvedValue({
      id: "org-1",
      memoryInjectionTopK: 1,
      memoryInjectionTokenBudget: 600,
    });
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
    expect(result).toContain("<approved_user_memory>");
    expect(result).toContain('type="preference"');
    expect(result).toContain("Loves concise answers");
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
