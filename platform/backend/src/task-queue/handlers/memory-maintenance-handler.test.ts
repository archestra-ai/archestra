import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { handleMemoryMaintenance } from "./memory-maintenance-handler";

const mockListAll = vi.hoisted(() => vi.fn());
const mockArchiveStaleCandidates = vi.hoisted(() => vi.fn());
const mockDeleteExpired = vi.hoisted(() => vi.fn());
const mockListFailedMemoryExtractionByOrg = vi.hoisted(() => vi.fn());
const mockSetMemoryExtractionStatus = vi.hoisted(() => vi.fn());
const mockEnqueue = vi.hoisted(() => vi.fn());

vi.mock("@/models", () => ({
  OrganizationModel: {
    listAll: mockListAll,
  },
  MemoryItemModel: {
    archiveStaleCandidates: mockArchiveStaleCandidates,
  },
  MemoryTombstoneModel: {
    deleteExpired: mockDeleteExpired,
  },
  ConversationModel: {
    listFailedMemoryExtractionByOrg: mockListFailedMemoryExtractionByOrg,
    setMemoryExtractionStatus: mockSetMemoryExtractionStatus,
  },
}));

vi.mock("@/task-queue", () => ({
  taskQueueService: {
    enqueue: mockEnqueue,
  },
}));

describe("handleMemoryMaintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAll.mockResolvedValue([
      {
        id: "org-enabled",
        memoryExtractionEnabled: true,
        memoryCandidateTtlDays: 11,
        memoryTombstoneTtlDays: 22,
      },
      {
        id: "org-disabled",
        memoryExtractionEnabled: false,
        memoryCandidateTtlDays: 33,
        memoryTombstoneTtlDays: 44,
      },
    ]);
    mockArchiveStaleCandidates.mockResolvedValue(0);
    mockDeleteExpired.mockResolvedValue(0);
    mockListFailedMemoryExtractionByOrg.mockResolvedValue([
      {
        id: "conv-1",
        userId: "user-1",
        organizationId: "org-enabled",
        agentId: "agent-1",
      },
    ]);
    mockEnqueue.mockResolvedValue("task-id");
    mockSetMemoryExtractionStatus.mockResolvedValue(undefined);
  });

  test("runs cleanup per organization with org-specific TTL values", async () => {
    await handleMemoryMaintenance();

    expect(mockArchiveStaleCandidates).toHaveBeenCalledWith({
      organizationId: "org-enabled",
      ttlDays: 11,
    });
    expect(mockArchiveStaleCandidates).toHaveBeenCalledWith({
      organizationId: "org-disabled",
      ttlDays: 33,
    });
    expect(mockDeleteExpired).toHaveBeenCalledWith({
      organizationId: "org-enabled",
      ttlDays: 22,
    });
    expect(mockDeleteExpired).toHaveBeenCalledWith({
      organizationId: "org-disabled",
      ttlDays: 44,
    });
  });

  test("enqueues retries only for organizations with extraction enabled", async () => {
    await handleMemoryMaintenance();

    expect(mockListFailedMemoryExtractionByOrg).toHaveBeenCalledWith({
      organizationId: "org-enabled",
      limit: 50,
    });
    expect(mockListFailedMemoryExtractionByOrg).not.toHaveBeenCalledWith({
      organizationId: "org-disabled",
      limit: 50,
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "memory_extract_candidates",
      payload: {
        conversationId: "conv-1",
        userId: "user-1",
        organizationId: "org-enabled",
        agentId: "agent-1",
      },
    });
  });
});
