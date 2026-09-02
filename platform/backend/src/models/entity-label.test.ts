import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect } from "vitest";
import { schema } from "@/database";
import { test } from "@/test";
import {
  createEntityLabelModel,
  LABEL_JUNCTIONS,
  pruneLabelKeysAndValues,
} from "./entity-label";
import { SkillLabelModel } from "./entity-labels";

describe("LABEL_JUNCTIONS", () => {
  /**
   * The one invariant that matters: pruning deletes any key/value that no
   * registered junction references, and that delete cascades. A junction table
   * missing from the registry therefore loses its labels the moment any other
   * entity syncs labels — silently, and only for rows whose key nothing else
   * happens to use. Catch the omission here instead.
   */
  test("covers every *_labels table in the schema", () => {
    const schemaLabelTables = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map((table) => getTableName(table as PgTable))
      .filter((name) => name.endsWith("_labels"))
      .sort();

    const registered = LABEL_JUNCTIONS.map((junction) =>
      getTableName(junction.table),
    ).sort();

    expect(registered).toEqual(schemaLabelTables);
  });
});

describe("createEntityLabelModel", () => {
  test("round-trips labels for one owner", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await createSkill(org.id, user.id, "round-trip");

    await SkillLabelModel.syncLabels(skill.id, [
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);

    const labels = await SkillLabelModel.getLabelsFor(skill.id);
    expect(labels.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "platform" },
    ]);
  });

  test("replaces the full label set on sync", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await createSkill(org.id, user.id, "replace");

    await SkillLabelModel.syncLabels(skill.id, [{ key: "env", value: "prod" }]);
    await SkillLabelModel.syncLabels(skill.id, [
      { key: "tier", value: "gold" },
    ]);

    const labels = await SkillLabelModel.getLabelsFor(skill.id);
    expect(labels.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "tier", value: "gold" },
    ]);
  });

  test("collapses a repeated key to its last value", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await createSkill(org.id, user.id, "dupe");

    await SkillLabelModel.syncLabels(skill.id, [
      { key: "env", value: "staging" },
      { key: "env", value: "prod" },
    ]);

    const labels = await SkillLabelModel.getLabelsFor(skill.id);
    expect(labels.map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "env", value: "prod" },
    ]);
  });

  test("batch load returns an entry per requested owner", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const labelled = await createSkill(org.id, user.id, "labelled");
    const bare = await createSkill(org.id, user.id, "bare");

    await SkillLabelModel.syncLabels(labelled.id, [
      { key: "env", value: "prod" },
    ]);

    const map = await SkillLabelModel.getLabelsForMany([labelled.id, bare.id]);
    expect(map.get(labelled.id)?.map((l) => l.key)).toEqual(["env"]);
    expect(map.get(bare.id)).toEqual([]);
  });

  describe("getIdsMatchingLabels", () => {
    test("ANDs across keys and ORs within a key's values", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const both = await createSkill(org.id, user.id, "both");
      const onlyEnv = await createSkill(org.id, user.id, "only-env");
      const otherEnv = await createSkill(org.id, user.id, "other-env");

      await SkillLabelModel.syncLabels(both.id, [
        { key: "env", value: "prod" },
        { key: "tier", value: "gold" },
      ]);
      await SkillLabelModel.syncLabels(onlyEnv.id, [
        { key: "env", value: "prod" },
      ]);
      await SkillLabelModel.syncLabels(otherEnv.id, [
        { key: "env", value: "dev" },
        { key: "tier", value: "gold" },
      ]);

      // Both keys must match, and "env" may be either value.
      const matches = await SkillLabelModel.getIdsMatchingLabels({
        env: ["prod", "dev"],
        tier: ["gold"],
      });

      expect(matches.sort()).toEqual([both.id, otherEnv.id].sort());
    });

    test("returns nothing when no owner carries every key", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const skill = await createSkill(org.id, user.id, "partial");
      await SkillLabelModel.syncLabels(skill.id, [
        { key: "env", value: "prod" },
      ]);

      expect(
        await SkillLabelModel.getIdsMatchingLabels({
          env: ["prod"],
          tier: ["gold"],
        }),
      ).toEqual([]);
    });

    test("an empty filter matches nothing rather than everything", async () => {
      expect(await SkillLabelModel.getIdsMatchingLabels({})).toEqual([]);
    });
  });

  describe("organization scoping", () => {
    test("keys and values are scoped to the caller's organization", async ({
      makeOrganization,
      makeUser,
    }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      const user = await makeUser();

      const skillA = await createSkill(orgA.id, user.id, "scoped-a");
      const skillB = await createSkill(orgB.id, user.id, "scoped-b");

      await SkillLabelModel.syncLabels(skillA.id, [
        { key: "owned-by-a", value: "value-a" },
      ]);
      await SkillLabelModel.syncLabels(skillB.id, [
        { key: "owned-by-b", value: "value-b" },
      ]);

      expect(await SkillLabelModel.getAllKeys(orgA.id)).toEqual(["owned-by-a"]);
      expect(await SkillLabelModel.getAllValues(orgA.id)).toEqual(["value-a"]);
      expect(
        await SkillLabelModel.getValuesByKey({
          organizationId: orgA.id,
          key: "owned-by-b",
        }),
      ).toEqual([]);
    });

    test("a soft-deleted owner stops contributing to the vocabulary", async ({
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const skill = await createSkill(org.id, user.id, "trashed");

      await SkillLabelModel.syncLabels(skill.id, [
        { key: "trashed-key", value: "trashed-value" },
      ]);
      expect(await SkillLabelModel.getAllKeys(org.id)).toEqual(["trashed-key"]);

      const db = (await import("@/database")).default;
      const { eq } = await import("drizzle-orm");
      await db
        .update(schema.skillsTable)
        .set({ deletedAt: new Date() })
        .where(eq(schema.skillsTable.id, skill.id));

      expect(await SkillLabelModel.getAllKeys(org.id)).toEqual([]);
    });
  });
});

describe("pruneLabelKeysAndValues", () => {
  test("keeps keys and values a registered junction still references", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const skill = await createSkill(org.id, user.id, "kept");

    await SkillLabelModel.syncLabels(skill.id, [
      { key: "kept-key", value: "kept-value" },
    ]);

    await pruneLabelKeysAndValues();

    expect(await SkillLabelModel.getLabelsFor(skill.id)).toHaveLength(1);
  });

  test("deletes keys and values nothing references", async () => {
    // Inserted directly rather than via a sync-then-clear, because syncLabels
    // fires its own pruning and would race this assertion.
    const db = (await import("@/database")).default;
    await db.insert(schema.labelKeysTable).values({ key: "orphan-key" });
    await db.insert(schema.labelValuesTable).values({ value: "orphan-value" });

    const { deletedKeys, deletedValues } = await pruneLabelKeysAndValues();
    expect(deletedKeys).toBeGreaterThanOrEqual(1);
    expect(deletedValues).toBeGreaterThanOrEqual(1);

    const { eq } = await import("drizzle-orm");
    expect(
      await db
        .select()
        .from(schema.labelKeysTable)
        .where(eq(schema.labelKeysTable.key, "orphan-key")),
    ).toEqual([]);
  });
});

describe("createEntityLabelModel config", () => {
  test("ownerIdKey names the junction's owner property", () => {
    // A wrong ownerIdKey only fails at insert time, deep inside a sync, so
    // assert the contract directly against the table's own columns.
    for (const config of [
      { table: schema.skillLabelsTable, key: "skillId" },
      { table: schema.oauthClientLabelsTable, key: "clientId" },
      { table: schema.kbFileLabelsTable, key: "fileId" },
    ]) {
      expect(Object.keys(config.table)).toContain(config.key);
    }
  });

  test("the factory produces the full model surface", () => {
    const model = createEntityLabelModel({
      junction: {
        table: schema.skillLabelsTable,
        keyId: schema.skillLabelsTable.keyId,
        valueId: schema.skillLabelsTable.valueId,
      },
      ownerIdColumn: schema.skillLabelsTable.skillId,
      ownerIdKey: "skillId",
      owner: {
        table: schema.skillsTable,
        idColumn: schema.skillsTable.id,
        organizationScope: () => undefined,
      },
    });

    expect(Object.keys(model).sort()).toEqual([
      "getAllKeys",
      "getAllValues",
      "getIdsMatchingLabels",
      "getLabelsFor",
      "getLabelsForMany",
      "getValuesByKey",
      "syncLabels",
    ]);
  });
});

async function createSkill(
  organizationId: string,
  authorId: string,
  name: string,
) {
  const db = (await import("@/database")).default;
  const [skill] = await db
    .insert(schema.skillsTable)
    .values({
      organizationId,
      authorId,
      name,
      scope: "org",
      description: `${name} skill`,
      content: "# skill",
      latestVersion: 1,
    })
    .returning();
  return skill;
}
