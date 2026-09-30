import { describe, expect, test } from "@/test";
import ChatOpsProcessedMessageModel from "./chatops-processed-message";

describe("ChatOpsProcessedMessageModel", () => {
  describe("tryMarkAsProcessed", () => {
    test("returns true for new message", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const messageId = `msg-${crypto.randomUUID()}`;
      const result = await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId,
      });
      expect(result).toBe(true);
    });

    test("returns false for duplicate message", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const messageId = `msg-${crypto.randomUUID()}`;

      // First attempt should succeed
      const firstResult = await ChatOpsProcessedMessageModel.tryMarkAsProcessed(
        { botId: bot.id, messageId },
      );
      expect(firstResult).toBe(true);

      // Second attempt should return false (duplicate)
      const secondResult =
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
          botId: bot.id,
          messageId,
        });
      expect(secondResult).toBe(false);
    });

    test("handles different message IDs independently", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);

      const result1 = await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId: `msg-${crypto.randomUUID()}`,
      });
      const result2 = await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId: `msg-${crypto.randomUUID()}`,
      });

      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    test("a message delivered to two bots is claimed once per bot", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const archestra = await makeChatOpsBot(org.id);
      const clode = await makeChatOpsBot(org.id);
      // Slack stamps the same ts on the copy each app receives.
      const messageId = `msg-${crypto.randomUUID()}`;

      expect(
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
          botId: archestra.id,
          messageId,
        }),
      ).toBe(true);
      expect(
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
          botId: clode.id,
          messageId,
        }),
      ).toBe(true);

      // A redelivery to either bot is still recognised as a duplicate.
      expect(
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
          botId: archestra.id,
          messageId,
        }),
      ).toBe(false);
      expect(
        await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
          botId: clode.id,
          messageId,
        }),
      ).toBe(false);
    });
  });

  describe("isProcessed", () => {
    test("returns false for unprocessed message", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const isProcessed = await ChatOpsProcessedMessageModel.isProcessed({
        botId: bot.id,
        messageId: `msg-${crypto.randomUUID()}`,
      });
      expect(isProcessed).toBe(false);
    });

    test("returns true for processed message", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const messageId = `msg-${crypto.randomUUID()}`;

      await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId,
      });

      const isProcessed = await ChatOpsProcessedMessageModel.isProcessed({
        botId: bot.id,
        messageId,
      });
      expect(isProcessed).toBe(true);
    });

    test("is scoped to the bot that claimed the message", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const archestra = await makeChatOpsBot(org.id);
      const clode = await makeChatOpsBot(org.id);
      const messageId = `msg-${crypto.randomUUID()}`;

      await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: archestra.id,
        messageId,
      });

      expect(
        await ChatOpsProcessedMessageModel.isProcessed({
          botId: clode.id,
          messageId,
        }),
      ).toBe(false);
    });
  });

  describe("cleanupOldRecords", () => {
    test("removes records older than cutoff date", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const messageId1 = `msg-${crypto.randomUUID()}`;
      const messageId2 = `msg-${crypto.randomUUID()}`;

      // Create records
      await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId: messageId1,
      });
      await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId: messageId2,
      });

      // Both should be processed now
      expect(
        await ChatOpsProcessedMessageModel.isProcessed({
          botId: bot.id,
          messageId: messageId1,
        }),
      ).toBe(true);
      expect(
        await ChatOpsProcessedMessageModel.isProcessed({
          botId: bot.id,
          messageId: messageId2,
        }),
      ).toBe(true);

      // Cleanup with a cutoff in the future (should delete all)
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);
      await ChatOpsProcessedMessageModel.cleanupOldRecords(futureDate);

      // Verify records are gone (PGlite may not return accurate rowCount)
      expect(
        await ChatOpsProcessedMessageModel.isProcessed({
          botId: bot.id,
          messageId: messageId1,
        }),
      ).toBe(false);
      expect(
        await ChatOpsProcessedMessageModel.isProcessed({
          botId: bot.id,
          messageId: messageId2,
        }),
      ).toBe(false);
    });

    test("does not remove recent records", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const messageId = `msg-${crypto.randomUUID()}`;

      await ChatOpsProcessedMessageModel.tryMarkAsProcessed({
        botId: bot.id,
        messageId,
      });

      // Cleanup with a cutoff in the past (should not delete anything)
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      await ChatOpsProcessedMessageModel.cleanupOldRecords(pastDate);

      // Verify record still exists (not deleted)
      expect(
        await ChatOpsProcessedMessageModel.isProcessed({
          botId: bot.id,
          messageId,
        }),
      ).toBe(true);
    });
  });
});
