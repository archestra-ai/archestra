import { describe, expect, test } from "@/test";
import UserMemoryModel from "./user-memory";

describe("UserMemoryModel", () => {
  describe("create", () => {
    test("creates a memory entry", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const memory = await UserMemoryModel.create({
        userId: user.id,
        organizationId: org.id,
        title: "Preferred language",
        content: "Always respond in British English",
      });

      expect(memory.title).toBe("Preferred language");
      expect(memory.content).toBe("Always respond in British English");
      expect(memory.userId).toBe(user.id);
      expect(memory.organizationId).toBe(org.id);
      expect(memory.id).toBeDefined();
    });
  });

  describe("findAllForUser", () => {
    test("returns entries ordered by creation time", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      await UserMemoryModel.create({
        userId: user.id,
        organizationId: org.id,
        title: "First",
        content: "Content A",
      });
      await UserMemoryModel.create({
        userId: user.id,
        organizationId: org.id,
        title: "Second",
        content: "Content B",
      });

      const memories = await UserMemoryModel.findAllForUser(user.id, org.id);

      expect(memories).toHaveLength(2);
      expect(memories[0].title).toBe("First");
      expect(memories[1].title).toBe("Second");
    });

    test("does not return entries belonging to other users", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const other = await makeUser();
      await makeMember(user.id, org.id);
      await makeMember(other.id, org.id);

      await UserMemoryModel.create({
        userId: other.id,
        organizationId: org.id,
        title: "Other user memory",
        content: "Should not appear",
      });

      const memories = await UserMemoryModel.findAllForUser(user.id, org.id);
      expect(memories).toHaveLength(0);
    });
  });

  describe("update", () => {
    test("updates title and content", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const memory = await UserMemoryModel.create({
        userId: user.id,
        organizationId: org.id,
        title: "Old title",
        content: "Old content",
      });

      const updated = await UserMemoryModel.update(memory.id, user.id, {
        title: "New title",
        content: "New content",
      });

      expect(updated?.title).toBe("New title");
      expect(updated?.content).toBe("New content");
    });

    test("returns undefined when entry not found or belongs to another user", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const other = await makeUser();
      await makeMember(user.id, org.id);
      await makeMember(other.id, org.id);

      const memory = await UserMemoryModel.create({
        userId: other.id,
        organizationId: org.id,
        title: "Title",
        content: "Content",
      });

      const result = await UserMemoryModel.update(memory.id, user.id, {
        title: "Hacked",
      });
      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    test("deletes an entry", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const memory = await UserMemoryModel.create({
        userId: user.id,
        organizationId: org.id,
        title: "To delete",
        content: "Will be gone",
      });

      const deleted = await UserMemoryModel.delete(memory.id, user.id);
      expect(deleted).toBe(true);

      const remaining = await UserMemoryModel.findAllForUser(user.id, org.id);
      expect(remaining).toHaveLength(0);
    });

    test("returns false when entry does not belong to the user", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const other = await makeUser();
      await makeMember(user.id, org.id);
      await makeMember(other.id, org.id);

      const memory = await UserMemoryModel.create({
        userId: other.id,
        organizationId: org.id,
        title: "Protected",
        content: "Should not be deletable",
      });

      const deleted = await UserMemoryModel.delete(memory.id, user.id);
      expect(deleted).toBe(false);
    });
  });
});
