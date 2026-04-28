import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

const mockExtract = vi.hoisted(() => vi.fn());
const mockHasExternalContextBoundary = vi.hoisted(() => vi.fn());
vi.mock("./extractor", () => ({
  memoryExtractor: {
    extract: mockExtract,
  },
  hasExternalContextBoundary: mockHasExternalContextBoundary,
}));

const mockFindConversation = vi.hoisted(() => vi.fn());
const mockSetMemoryExtractionStatus = vi.hoisted(() => vi.fn());
const mockHasPendingByTypeAndPayload = vi.hoisted(() => vi.fn());
const mockGetOrganizationById = vi.hoisted(() => vi.fn());
vi.mock("@/models", () => ({
  ConversationModel: {
    findById: mockFindConversation,
    setMemoryExtractionStatus: mockSetMemoryExtractionStatus,
  },
  OrganizationModel: {
    getById: mockGetOrganizationById,
  },
  TaskModel: {
    hasPendingByTypeAndPayload: mockHasPendingByTypeAndPayload,
  },
}));

vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { handleExtractMemoryCandidates } from "./extractor-task-handler";

const payload = {
  conversationId: "5bc95922-c4cb-4922-b8d4-b7f59111fef4",
  userId: "user-1",
  organizationId: "org-1",
  agentId: "dc8a1fb7-680a-43cd-af9c-adb7f5ed7d0c",
};

describe("handleExtractMemoryCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrganizationById.mockResolvedValue({
      id: payload.organizationId,
      memoryExtractionEnabled: true,
    });
    mockHasPendingByTypeAndPayload.mockResolvedValue(false);
    mockFindConversation.mockResolvedValue({
      id: payload.conversationId,
      messages: [],
    });
    mockHasExternalContextBoundary.mockReturnValue(false);
    mockExtract.mockResolvedValue({
      status: "completed",
      insertedCount: 1,
      skippedCount: 0,
    });
  });

  test("skips when extraction is disabled for organization", async () => {
    mockGetOrganizationById.mockResolvedValue({
      id: payload.organizationId,
      memoryExtractionEnabled: false,
    });

    await handleExtractMemoryCandidates(payload);

    expect(mockHasPendingByTypeAndPayload).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test("skips when pending duplicate task exists", async () => {
    mockHasPendingByTypeAndPayload.mockResolvedValue(true);

    await handleExtractMemoryCandidates(payload);

    expect(mockHasPendingByTypeAndPayload).toHaveBeenCalledWith({
      taskType: "memory_extract_candidates",
      conversationId: payload.conversationId,
    });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  test("skips when conversation has external context boundary", async () => {
    mockHasExternalContextBoundary.mockReturnValue(true);

    await handleExtractMemoryCandidates(payload);

    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockSetMemoryExtractionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped" }),
    );
  });

  test("runs extractor and marks completed", async () => {
    await handleExtractMemoryCandidates(payload);

    expect(mockExtract).toHaveBeenCalledWith(payload);
    expect(mockSetMemoryExtractionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  test("rethrows unexpected extractor errors for task retry", async () => {
    mockExtract.mockRejectedValue(new Error("extract failed"));

    await expect(handleExtractMemoryCandidates(payload)).rejects.toThrow(
      "extract failed",
    );
    expect(mockSetMemoryExtractionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });
});
