import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { PluginModel } from "@/models";
import { describe, expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0666_broken_tombstone.sql"),
  "utf8",
);

/** The migration's step for switched-off plugins; the tables already exist. */
async function runSwitchedOffStep() {
  const steps = migration
    .split("--> statement-breakpoint")
    .filter((statement) => statement.includes('UPDATE "plugins"'));
  expect(steps).toHaveLength(1);
  await db.execute(sql.raw(steps[0]));
}

describe("plugins that were switched off before the switch was removed", () => {
  test("move to the trash, as a delete leaves them, and the others stay", async ({
    makeOrganization,
    makeAdmin,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const user = await makeAdmin();
    const plugins = schema.pluginsTable;
    const create = async (displayName: string) => {
      const plugin = await PluginModel.create({
        organizationId,
        userId: user.id,
        input: {
          displayName,
          description: "A plugin from before the upgrade.",
          clientType: "claude-code",
          files: [
            {
              path: "README.md",
              content: "Instructions",
              encoding: "utf8",
              mode: "100644",
            },
          ],
        },
      });
      if (!plugin) throw new Error("the plugin was not created");
      return plugin;
    };
    const row = async (id: string) =>
      (await db.select().from(plugins).where(eq(plugins.id, id)))[0];
    const on = await create("Switched on");
    const off = await create("Switched off");
    const gone = await create("Deleted before");
    await db
      .update(plugins)
      .set({
        enabled: false,
        githubSyncInterval: "1h",
        pendingSourceSha: "abc",
        pendingContentHash: "def",
        pendingDetectedAt: new Date(),
      })
      .where(eq(plugins.id, off.id));
    // A delete used to switch the plugin off as well.
    const deletedBefore = new Date("2026-01-01T00:00:00Z");
    await db
      .update(plugins)
      .set({ enabled: false, deletedAt: deletedBefore })
      .where(eq(plugins.id, gone.id));

    const generationBefore = (await row(off.id)).syncGeneration;

    await runSwitchedOffStep();

    expect((await row(on.id)).deletedAt).toBeNull();
    expect(await row(off.id)).toMatchObject({
      deletedAt: expect.any(Date),
      githubSyncInterval: null,
      pendingSourceSha: null,
      pendingContentHash: null,
      pendingDetectedAt: null,
      syncGeneration: generationBefore + 1,
    });
    // Already in the trash: left as it was.
    expect((await row(gone.id)).deletedAt).toEqual(deletedBefore);

    // Not installable, and listed where an admin can bring it back.
    expect(
      await PluginModel.findById({ id: off.id, organizationId }),
    ).toBeNull();
    expect(
      await PluginModel.findDeletedById({ id: off.id, organizationId }),
    ).not.toBeNull();
    expect(await PluginModel.restore({ id: off.id, organizationId })).toBe(
      true,
    );
    expect(
      await PluginModel.findById({ id: off.id, organizationId }),
    ).not.toBeNull();
  });
});
