import { describe, expect, test } from "@/test";
import ChatOpsProcessedMessageModel from "./chatops-processed-message";

describe("ChatOpsProcessedMessageModel", () => {
  describe("tryMarkAsProcessed", () => {
    test("returns true for new message", async () => {
      const messageId = `msg-${crypto.randomUUID()}`;
      const result =
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId);
      expect(result).toBe(true);
    });

    test("returns false for duplicate message", async () => {
      const messageId = `msg-${crypto.randomUUID()}`;

      // First attempt should succeed
      const firstResult =
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId);
      expect(firstResult).toBe(true);

      // Second attempt should return false (duplicate)
      const secondResult =
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId);
      expect(secondResult).toBe(false);
    });

    test("handles different message IDs independently", async () => {
      const messageId1 = `msg-${crypto.randomUUID()}`;
      const messageId2 = `msg-${crypto.randomUUID()}`;

      const result1 =
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId1);
      const result2 =
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId2);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });
  });

  describe("isProcessed", () => {
    test("returns false for unprocessed message", async () => {
      const messageId = `msg-${crypto.randomUUID()}`;
      const isProcessed =
        await ChatOpsProcessedMessageModel.isProcessed(messageId);
      expect(isProcessed).toBe(false);
    });

    test("returns true for processed message", async () => {
      const messageId = `msg-${crypto.randomUUID()}`;

      await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId);

      const isProcessed =
        await ChatOpsProcessedMessageModel.isProcessed(messageId);
      expect(isProcessed).toBe(true);
    });
  });

  describe("cleanupOldRecords", () => {
    test("removes records older than cutoff date", async () => {
      const messageId1 = `msg-${crypto.randomUUID()}`;
      const messageId2 = `msg-${crypto.randomUUID()}`;

      // Create records
      await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId1);
      await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId2);

      // Both should be processed now
      expect(await ChatOpsProcessedMessageModel.isProcessed(messageId1)).toBe(
        true,
      );
      expect(await ChatOpsProcessedMessageModel.isProcessed(messageId2)).toBe(
        true,
      );

      // Cleanup with a cutoff in the future (should delete all)
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);
      await ChatOpsProcessedMessageModel.cleanupOldRecords(futureDate);

      // Verify records are gone (PGlite may not return accurate rowCount)
      expect(await ChatOpsProcessedMessageModel.isProcessed(messageId1)).toBe(
        false,
      );
      expect(await ChatOpsProcessedMessageModel.isProcessed(messageId2)).toBe(
        false,
      );
    });

    test("does not remove recent records", async () => {
      const messageId = `msg-${crypto.randomUUID()}`;

      await ChatOpsProcessedMessageModel.tryMarkAsProcessed(messageId);

      // Cleanup with a cutoff in the past (should not delete anything)
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      await ChatOpsProcessedMessageModel.cleanupOldRecords(pastDate);

      // Verify record still exists (not deleted)
      expect(await ChatOpsProcessedMessageModel.isProcessed(messageId)).toBe(
        true,
      );
    });
  });
});
