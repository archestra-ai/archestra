import { vi } from "vitest";
import MemoryItemModel from "@/models/memory-item";
import { describe, expect, test } from "@/test";
import type { MemoryItem } from "@/types/memory-item";
import { listForInjection } from "./retrieval-service";

describe("memory retrieval service", () => {
  test("defaults to user scope only and keeps includeOrganizationScope disabled", async () => {
    vi.spyOn(MemoryItemModel, "incrementRetrievalCount").mockResolvedValue();
    const listSpy = vi
      .spyOn(MemoryItemModel, "listApprovedForRetrieval")
      .mockResolvedValue([
        makeItem({
          id: "user-item",
          scopeType: "user",
          content: "user memory",
        }),
        makeItem({
          id: "team-item",
          scopeType: "team",
          scopeId: "team-1",
          content: "team memory",
        }),
      ]);

    const result = await listForInjection({
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(listSpy).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
      teamIds: [],
      limit: 100,
      includeOrganizationScope: false,
    });
    expect(result.map((item) => item.id)).toEqual(["user-item"]);
  });

  test("supports team and organization scopes when explicitly enabled", async () => {
    vi.spyOn(MemoryItemModel, "incrementRetrievalCount").mockResolvedValue();
    vi.spyOn(MemoryItemModel, "listApprovedForRetrieval").mockResolvedValue([
      makeItem({
        id: "org-old",
        scopeType: "organization",
        scopeId: "org-1",
        kind: "org_fact",
        lastVerifiedAt: new Date("2024-01-01T00:00:00.000Z"),
      }),
      makeItem({
        id: "team-recent",
        scopeType: "team",
        scopeId: "team-1",
        kind: "team_convention",
        lastVerifiedAt: new Date("2024-03-01T00:00:00.000Z"),
      }),
      makeItem({
        id: "user-recent",
        scopeType: "user",
        kind: "instruction",
        lastVerifiedAt: new Date("2024-04-01T00:00:00.000Z"),
      }),
      makeItem({
        id: "user-recent-z",
        scopeType: "user",
        kind: "preference",
        lastVerifiedAt: new Date("2024-04-01T00:00:00.000Z"),
      }),
    ]);

    const result = await listForInjection({
      userId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      scopesEnabled: ["team", "organization", "user"],
    });

    // "user-recent" has kind=instruction and is filtered by isEligibleForRetrieval
    expect(result.map((item) => item.id)).toEqual([
      "user-recent-z",
      "team-recent",
      "org-old",
    ]);
  });

  test("falls back to user scope when scopes list is invalid", async () => {
    vi.spyOn(MemoryItemModel, "incrementRetrievalCount").mockResolvedValue();
    vi.spyOn(MemoryItemModel, "listApprovedForRetrieval").mockResolvedValue([
      makeItem({
        id: "user-item",
        scopeType: "user",
      }),
      makeItem({
        id: "team-item",
        scopeType: "team",
        scopeId: "team-1",
      }),
    ]);

    const result = await listForInjection({
      userId: "user-1",
      organizationId: "org-1",
      teamIds: ["team-1"],
      scopesEnabled: ["not-valid" as never],
    });

    expect(result.map((item) => item.id)).toEqual(["user-item"]);
  });
});

function makeItem(overrides: Partial<MemoryItem>): MemoryItem {
  const now = new Date("2024-05-01T00:00:00.000Z");

  return {
    id: overrides.id ?? crypto.randomUUID(),
    organizationId: overrides.organizationId ?? "org-1",
    scopeType: overrides.scopeType ?? "user",
    scopeId: overrides.scopeId ?? "user-1",
    kind: overrides.kind ?? "preference",
    status: overrides.status ?? "approved",
    content: overrides.content ?? "memory content",
    createdBy: overrides.createdBy ?? "user-1",
    reviewedBy: overrides.reviewedBy ?? "user-1",
    reviewedAt: overrides.reviewedAt ?? now,
    rejectionReason: overrides.rejectionReason ?? null,
    rejectionComment: overrides.rejectionComment ?? null,
    extractorVersion: overrides.extractorVersion ?? null,
    policyFlags: overrides.policyFlags ?? [],
    sourceType: overrides.sourceType ?? null,
    sourceId: overrides.sourceId ?? null,
    sourceMetadata: overrides.sourceMetadata ?? null,
    sourceConversationId: overrides.sourceConversationId ?? null,
    sourceMessageIds: overrides.sourceMessageIds ?? null,
    supersedesMemoryId: overrides.supersedesMemoryId ?? null,
    confidenceBand: overrides.confidenceBand ?? null,
    language: overrides.language ?? null,
    scores: overrides.scores ?? null,
    classifications: overrides.classifications ?? null,
    scorerVersion: overrides.scorerVersion ?? null,
    lastRetrievedAt: overrides.lastRetrievedAt ?? null,
    retrievalCount: overrides.retrievalCount ?? 0,
    lastVerifiedAt: overrides.lastVerifiedAt ?? now,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
