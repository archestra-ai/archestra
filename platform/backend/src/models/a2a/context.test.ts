import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import db, { schema } from "@/database";
import { isUuid } from "@/utils/uuid";
import A2AContextModel from "./context";

describe("A2AContextModel", () => {
  describe("create", () => {
    test("can create a context", async () => {
      const actorKind = "user";
      const actorId = crypto.randomUUID();

      const context = await A2AContextModel.create({
        actorKind,
        actorId,
      });

      expect(context.id).toBeDefined();
      expect(context.actorKind).toBe(actorKind);
      expect(context.actorId).toBe(actorId);
      expect(context.createdAt).toBeDefined();
      expect(context.updatedAt).toBeDefined();
    });
  });

  describe("findById", () => {
    test("returns the context by id", async () => {
      const actorKind = "user";
      const actorId = crypto.randomUUID();
      const created = await A2AContextModel.create({
        actorKind,
        actorId,
      });

      const found = await A2AContextModel.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.actorKind).toBe(actorKind);
      expect(found?.actorId).toBe(actorId);
    });

    test("returns null for an unknown id", async () => {
      const found = await A2AContextModel.findById(crypto.randomUUID());

      expect(found).toBeNull();
    });
  });

  describe("delete", () => {
    test("removes a context", async () => {
      const originalCount = await A2AContextModel.getTotalCount();
      const context = await A2AContextModel.create({
        actorKind: "user",
        actorId: crypto.randomUUID(),
      });

      expect(await A2AContextModel.getTotalCount()).toBe(originalCount + 1);

      await A2AContextModel.delete(context.id);
      expect(await A2AContextModel.findById(context.id)).toBeNull();
      expect(await A2AContextModel.getTotalCount()).toBe(originalCount);
    });
  });

  describe("getOrCreateForExternalThread", () => {
    const thread = {
      organizationId: "org-1",
      actorKind: "system",
      actorId: "system",
      agentId: "11111111-1111-4111-8111-111111111111",
      externalThread: JSON.stringify([
        "email",
        "outlook",
        "agents@example.com",
        "conversation:thread-1",
        "sender@example.com",
      ]),
    };

    test("reuses one deterministic context and refuses a different owner", async () => {
      const [first, second, third] = await Promise.all([
        A2AContextModel.getOrCreateForExternalThread(thread),
        A2AContextModel.getOrCreateForExternalThread(thread),
        A2AContextModel.getOrCreateForExternalThread(thread),
      ]);

      expect(isUuid(first.id)).toBe(true);
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(
        (
          await A2AContextModel.getOrCreateForExternalThread({
            ...thread,
            organizationId: "org-2",
          })
        ).id,
      ).not.toBe(first.id);
      expect(
        (
          await A2AContextModel.getOrCreateForExternalThread({
            ...thread,
            externalThread: `${thread.externalThread}-other-sender`,
          })
        ).id,
      ).not.toBe(first.id);

      await db
        .update(schema.a2aContextsTable)
        .set({ actorId: "other-actor" })
        .where(eq(schema.a2aContextsTable.id, first.id));
      await expect(
        A2AContextModel.getOrCreateForExternalThread(thread),
      ).rejects.toThrow(/different actor/);
    });
  });
});
