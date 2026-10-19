import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0578_remove_seeded_openappa_plugin.sql"),
  "utf8",
);

test("soft-deletes the OpenAPPA Claude Code plugin and leaves other plugins alone", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const seedPlugin = async (
    values: Partial<typeof schema.pluginsTable.$inferInsert>,
  ) => {
    const [plugin] = await db
      .insert(schema.pluginsTable)
      .values({
        organizationId: org.id,
        authorId: user.id,
        scope: "org",
        clientType: "claude-code",
        pluginSlug: `plugin-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Plugin",
        contentHash: crypto.randomUUID(),
        ...values,
      })
      .returning();
    return plugin;
  };
  const marketplaceImport = await seedPlugin({
    displayName: "OpenAPPA",
    sourceMarketplaceRepo: "Archestra-AI/OpenAPPA",
    sourceMarketplacePath: ".claude-plugin/marketplace.json",
    sourceMarketplacePluginName: "appa-runtime",
    githubSyncInterval: "1d",
  });
  const legacySeed = await seedPlugin({
    sourceId: "managed:openappa:claude-code",
  });
  const otherFromSameRepo = await seedPlugin({
    sourceMarketplaceRepo: "archestra-ai/OpenAPPA",
    sourceMarketplacePath: ".claude-plugin/marketplace.json",
    sourceMarketplacePluginName: "something-else",
  });
  const unrelated = await seedPlugin({ displayName: "superpowers" });
  const row = async (id: string) =>
    (
      await db
        .select()
        .from(schema.pluginsTable)
        .where(eq(schema.pluginsTable.id, id))
    )[0];

  await db.execute(sql.raw(migrationSql));

  for (const id of [marketplaceImport.id, legacySeed.id]) {
    const removed = await row(id);
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.enabled).toBe(false);
    expect(removed.githubSyncInterval).toBeNull();
  }
  expect(await row(otherFromSameRepo.id)).toEqual(otherFromSameRepo);
  expect(await row(unrelated.id)).toEqual(unrelated);

  const removed = await row(marketplaceImport.id);
  await db.execute(sql.raw(migrationSql));
  expect(await row(marketplaceImport.id)).toEqual(removed);
});
