import { eq } from "drizzle-orm";
import { A2AProtocolTaskState } from "@/agents/a2a/a2a-protocol";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import A2AContextModel from "./a2a-context";
import A2ATaskModel from "./a2a-task";

async function createContext() {
  return await A2AContextModel.create({
    actorKind: "user",
    actorId: crypto.randomUUID(),
  });
}

describe("A2ATaskModel", () => {
  describe("create", () => {
    test("updates context updatedAt when a task is created", async () => {
      const context = await createContext();
      const originalUpdatedAt = context.updatedAt;

      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      expect(task.id).toBeDefined();
      expect(task.contextId).toBe(context.id);
      expect(task.state).toBe(A2AProtocolTaskState.Submitted);

      const [updatedContext] = await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context.id));

      expect(updatedContext.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });
  });

  describe("findById", () => {
    test("returns a task by id", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      const found = await A2ATaskModel.findById(task.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(task.id);
      expect(found?.contextId).toBe(context.id);
      expect(found?.state).toBe(A2AProtocolTaskState.Submitted);
    });
  });

  describe("updateState", () => {
    test("updates task state and updatedAt", async () => {
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      const [beforeUpdate] = await db
        .select()
        .from(schema.a2aTasksTable)
        .where(eq(schema.a2aTasksTable.id, task.id));

      await A2ATaskModel.updateState(task.id, A2AProtocolTaskState.Completed);

      const [updatedTask] = await db
        .select()
        .from(schema.a2aTasksTable)
        .where(eq(schema.a2aTasksTable.id, task.id));

      expect(updatedTask.state).toBe(A2AProtocolTaskState.Completed);
      expect(updatedTask.updatedAt.getTime()).toBeGreaterThan(
        beforeUpdate.updatedAt.getTime(),
      );
      expect((await A2ATaskModel.findById(task.id))?.state).toBe(
        A2AProtocolTaskState.Completed,
      );
    });
  });

  describe("delete", () => {
    test("removes a task", async () => {
      const originalCount = await A2ATaskModel.getTotalCount();
      const context = await createContext();
      const task = await A2ATaskModel.create({
        contextId: context.id,
        state: A2AProtocolTaskState.Submitted,
      });

      expect(await A2ATaskModel.getTotalCount()).toBe(originalCount + 1);

      await A2ATaskModel.delete(task.id);
      expect(await A2ATaskModel.findById(task.id)).toBeNull();
      expect(await A2ATaskModel.getTotalCount()).toBe(originalCount);
    });
  });
});
