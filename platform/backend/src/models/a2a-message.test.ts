import { eq } from "drizzle-orm";
import {
  A2AProtocolRole,
  A2AProtocolTaskState,
} from "@/agents/a2a/a2a-protocol";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import A2AContextModel from "./a2a-context";
import A2AMessageModel, { A2AMessageIdExistsError } from "./a2a-message";
import A2ATaskModel from "./a2a-task";

async function createContext() {
  return await A2AContextModel.create({
    actorKind: "user",
    actorId: crypto.randomUUID(),
  });
}

async function createTask(contextId: string) {
  return await A2ATaskModel.create({
    contextId,
    state: A2AProtocolTaskState.Submitted,
  });
}

function makeTextParts(text: string) {
  return [{ type: "text", text }];
}

function makeContent(messageId: string, role: A2AProtocolRole, text: string) {
  return {
    messageId,
    role,
    parts: makeTextParts(text),
  };
}

describe("A2AMessageModel", () => {
  describe("create", () => {
    test("updates context updatedAt when a message is created", async () => {
      const context = await createContext();
      const originalUpdatedAt = context.updatedAt;

      const message = await A2AMessageModel.create({
        contextId: context.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("Hello"),
        content: makeContent("message-1", A2AProtocolRole.User, "Hello"),
      });

      expect(message.id).toBeDefined();
      expect(message.contextId).toBe(context.id);
      expect(message.role).toBe(A2AProtocolRole.User);

      const [updatedContext] = await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context.id));

      expect(updatedContext.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });
  });

  describe("createWithId", () => {
    test("throws A2AMessageIdExistsError when a message with the same ID already exists", async () => {
      const context = await createContext();
      const messageId = crypto.randomUUID();

      await A2AMessageModel.createWithId({
        id: messageId,
        contextId: context.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("Hello"),
        content: makeContent(messageId, A2AProtocolRole.User, "Hello"),
      });

      await expect(
        A2AMessageModel.createWithId({
          id: messageId,
          contextId: context.id,
          role: A2AProtocolRole.User,
          parts: makeTextParts("Hello again"),
          content: makeContent(messageId, A2AProtocolRole.User, "Hello again"),
        }),
      ).rejects.toThrow(A2AMessageIdExistsError);
    });
  });

  describe("bulkCreate", () => {
    test("updates multiple contexts when messages are bulk created", async () => {
      const context1 = await createContext();
      const context2 = await createContext();
      const original1 = context1.updatedAt;
      const original2 = context2.updatedAt;

      await A2AMessageModel.bulkCreate([
        {
          contextId: context1.id,
          role: A2AProtocolRole.User,
          parts: makeTextParts("Message 1"),
          content: makeContent("message-1", A2AProtocolRole.User, "Message 1"),
        },
        {
          contextId: context2.id,
          role: A2AProtocolRole.Agent,
          parts: makeTextParts("Message 2"),
          content: makeContent("message-2", A2AProtocolRole.Agent, "Message 2"),
        },
      ]);

      const [updated1] = await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context1.id));
      const [updated2] = await db
        .select()
        .from(schema.a2aContextsTable)
        .where(eq(schema.a2aContextsTable.id, context2.id));

      expect(updated1.updatedAt.getTime()).toBeGreaterThan(original1.getTime());
      expect(updated2.updatedAt.getTime()).toBeGreaterThan(original2.getTime());
    });

    test("does not fail when bulk creating an empty array", async () => {
      await expect(A2AMessageModel.bulkCreate([])).resolves.not.toThrow();
    });
  });

  describe("findById", () => {
    test("returns a message by id", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const message = await A2AMessageModel.create({
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("Hello"),
        content: makeContent("message-1", A2AProtocolRole.User, "Hello"),
      });

      const found = await A2AMessageModel.findById(message.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(message.id);
      expect(found?.contextId).toBe(context.id);
      expect(found?.taskId).toBe(task.id);
      expect(found?.role).toBe(A2AProtocolRole.User);
      expect(found?.parts).toEqual(makeTextParts("Hello"));
      expect(found?.content).toEqual(
        makeContent("message-1", A2AProtocolRole.User, "Hello"),
      );
    });
  });

  describe("findByContextId", () => {
    test("returns messages ordered by createdAt and finds the last message", async () => {
      const context = await createContext();
      const first = await A2AMessageModel.create({
        contextId: context.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("First"),
        content: makeContent("message-1", A2AProtocolRole.User, "First"),
      });

      const second = await A2AMessageModel.create({
        contextId: context.id,
        role: A2AProtocolRole.Agent,
        parts: makeTextParts("Second"),
        content: makeContent("message-2", A2AProtocolRole.Agent, "Second"),
      });

      const messages = await A2AMessageModel.findByContextId(context.id);
      const last = await A2AMessageModel.findLastByContextId(context.id);

      expect(messages.map(({ id }) => id)).toEqual([first.id, second.id]);
      expect(last?.id).toBe(second.id);
    });
  });

  describe("findByTaskId", () => {
    test("returns messages ordered by createdAt and finds the last message", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const first = await A2AMessageModel.create({
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("First"),
        content: makeContent("message-1", A2AProtocolRole.User, "First"),
      });

      const second = await A2AMessageModel.create({
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.Agent,
        parts: makeTextParts("Second"),
        content: makeContent("message-2", A2AProtocolRole.Agent, "Second"),
      });

      const messages = await A2AMessageModel.findByTaskId(task.id);
      const last = await A2AMessageModel.findLastByTaskId(task.id);

      expect(messages.map(({ id }) => id)).toEqual([first.id, second.id]);
      expect(last?.id).toBe(second.id);
    });
  });

  describe("updateContent", () => {
    test("updates message content and updatedAt", async () => {
      const context = await createContext();
      const task = await createTask(context.id);
      const message = await A2AMessageModel.create({
        contextId: context.id,
        taskId: task.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("Original"),
        content: makeContent("message-1", A2AProtocolRole.User, "Original"),
      });

      const [beforeUpdate] = await db
        .select()
        .from(schema.a2aMessagesTable)
        .where(eq(schema.a2aMessagesTable.id, message.id));

      const updatedContent = makeContent(
        "message-1",
        A2AProtocolRole.User,
        "Updated",
      );
      await A2AMessageModel.updateContent(message.id, updatedContent);

      const [updatedMessage] = await db
        .select()
        .from(schema.a2aMessagesTable)
        .where(eq(schema.a2aMessagesTable.id, message.id));

      expect(updatedMessage.content).toEqual(updatedContent);
      expect(updatedMessage.updatedAt.getTime()).toBeGreaterThan(
        beforeUpdate.updatedAt.getTime(),
      );
      expect((await A2AMessageModel.findById(message.id))?.content).toEqual(
        updatedContent,
      );
    });
  });

  describe("delete", () => {
    test("removes a message", async () => {
      const originalCount = await A2AMessageModel.getTotalCount();
      const context = await createContext();
      const message = await A2AMessageModel.create({
        contextId: context.id,
        role: A2AProtocolRole.User,
        parts: makeTextParts("Delete me"),
        content: makeContent(
          "message-delete",
          A2AProtocolRole.User,
          "Delete me",
        ),
      });

      expect(await A2AMessageModel.getTotalCount()).toBe(originalCount + 1);

      await A2AMessageModel.delete(message.id);

      expect(await A2AMessageModel.findById(message.id)).toBeNull();
      expect(await A2AMessageModel.getTotalCount()).toBe(originalCount);
    });
  });
});
