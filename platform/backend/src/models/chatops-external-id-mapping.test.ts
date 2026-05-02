import { describe, expect, test } from "@/test";
import ChatOpsExternalIdMappingModel from "./chatops-external-id-mapping";

describe("ChatOpsExternalIdMappingModel", () => {
  describe("findByExternalId", () => {
    test("returns mapping when found", async ({ makeExternalIdMapping }) => {
      const mapping = await makeExternalIdMapping({
        adapterId: "whatsapp",
        externalId: "user-42",
      });

      const result =
        await ChatOpsExternalIdMappingModel.findByExternalId(
          "whatsapp",
          "user-42",
        );

      expect(result).toBeDefined();
      expect(result?.id).toBe(mapping.id);
      expect(result?.adapterId).toBe("whatsapp");
      expect(result?.externalId).toBe("user-42");
      expect(result?.userId).toBe(mapping.userId);
    });

    test("returns null when not found", async () => {
      const result =
        await ChatOpsExternalIdMappingModel.findByExternalId(
          "whatsapp",
          "nonexistent",
        );

      expect(result).toBeNull();
    });
  });

  describe("findByUserId", () => {
    test("returns multiple mappings for same user", async ({
      makeUser,
      makeExternalIdMapping,
    }) => {
      const user = await makeUser();
      await makeExternalIdMapping({
        userId: user.id,
        adapterId: "whatsapp",
        externalId: "ext-1",
      });
      await makeExternalIdMapping({
        userId: user.id,
        adapterId: "whatsapp",
        externalId: "ext-2",
      });

      const results =
        await ChatOpsExternalIdMappingModel.findByUserId(user.id);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.externalId).sort()).toEqual([
        "ext-1",
        "ext-2",
      ]);
    });

    test("returns empty array when user has no mappings", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const results =
        await ChatOpsExternalIdMappingModel.findByUserId(user.id);
      expect(results).toEqual([]);
    });
  });

  describe("create", () => {
    test("creates and returns mapping", async ({ makeUser }) => {
      const user = await makeUser();

      const mapping = await ChatOpsExternalIdMappingModel.create({
        adapterId: "whatsapp",
        externalId: "ext-new",
        userId: user.id,
      });

      expect(mapping).toBeDefined();
      expect(mapping.id).toBeDefined();
      expect(mapping.adapterId).toBe("whatsapp");
      expect(mapping.externalId).toBe("ext-new");
      expect(mapping.userId).toBe(user.id);
      expect(mapping.createdAt).toBeInstanceOf(Date);
    });
  });

  describe("deleteById", () => {
    test("deletes mapping and returns true", async ({
      makeExternalIdMapping,
    }) => {
      const mapping = await makeExternalIdMapping();

      const deleted =
        await ChatOpsExternalIdMappingModel.deleteById(mapping.id);

      expect(deleted).toBe(true);

      const found =
        await ChatOpsExternalIdMappingModel.findByExternalId(
          mapping.adapterId,
          mapping.externalId,
        );
      expect(found).toBeNull();
    });

    test("returns false for non-existent id", async () => {
      const deleted =
        await ChatOpsExternalIdMappingModel.deleteById(
          "00000000-0000-0000-0000-000000000000",
        );
      expect(deleted).toBe(false);
    });
  });

  describe("upsert", () => {
    test("creates new mapping when none exists", async ({ makeUser }) => {
      const user = await makeUser();

      const mapping = await ChatOpsExternalIdMappingModel.upsert({
        adapterId: "whatsapp",
        externalId: "ext-upsert-new",
        userId: user.id,
      });

      expect(mapping).toBeDefined();
      expect(mapping.adapterId).toBe("whatsapp");
      expect(mapping.externalId).toBe("ext-upsert-new");
      expect(mapping.userId).toBe(user.id);
    });

    test("updates userId when adapterId + externalId already exists", async ({
      makeUser,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();

      await ChatOpsExternalIdMappingModel.upsert({
        adapterId: "whatsapp",
        externalId: "ext-upsert-dup",
        userId: user1.id,
      });

      const updated =
        await ChatOpsExternalIdMappingModel.upsert({
          adapterId: "whatsapp",
          externalId: "ext-upsert-dup",
          userId: user2.id,
        });

      expect(updated.userId).toBe(user2.id);

      const found =
        await ChatOpsExternalIdMappingModel.findByExternalId(
          "whatsapp",
          "ext-upsert-dup",
        );
      expect(found?.userId).toBe(user2.id);
    });
  });
});
