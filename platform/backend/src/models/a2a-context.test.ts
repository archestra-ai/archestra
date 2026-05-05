import { describe, expect, test } from "@/test";
import A2AContextModel from "./a2a-context";

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
});
