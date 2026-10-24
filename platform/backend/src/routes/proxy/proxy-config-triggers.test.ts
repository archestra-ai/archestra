import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { PROXY_CONFIG_CHANNEL } from "./proxy-config-cache";

/**
 * The cache trusts these triggers to cover every write path, so they are
 * exercised against the migrated schema rather than through the models.
 */
describe("proxy configuration change notifications", () => {
  async function listen() {
    const tables: string[] = [];
    // Backend tests run on PGlite, which delivers notifications in-process.
    const client = db.$client as unknown as PGlite;
    const unlisten = await client.listen(PROXY_CONFIG_CHANNEL, (payload) =>
      tables.push(JSON.parse(payload).message),
    );
    /** Notifications are delivered in commit order; write a marker and wait. */
    const flush = async () => {
      await client.query(
        `select pg_notify('${PROXY_CONFIG_CHANNEL}', '{"origin":"database","message":"fence"}')`,
      );
      await expect.poll(() => tables.at(-1)).toBe("fence");
      return tables.splice(0).filter((table) => table !== "fence");
    };
    return { flush, unlisten };
  }

  test("a credential, gateway or membership change notifies", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    makeVirtualApiKey,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);
    const agent = await makeAgent({ organizationId: organization.id });
    const key = await makeVirtualApiKey(organization.id, { authorId: user.id });
    const { flush, unlisten } = await listen();

    await db
      .update(schema.virtualApiKeysTable)
      .set({ expiresAt: new Date() })
      .where(eq(schema.virtualApiKeysTable.id, key.id));
    await db
      .update(schema.agentsTable)
      .set({ name: "renamed" })
      .where(eq(schema.agentsTable.id, agent.id));
    await db
      .delete(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, user.id),
          eq(schema.membersTable.organizationId, organization.id),
        ),
      );

    expect(await flush()).toEqual(["virtual_api_keys", "agents", "member"]);
    await unlisten();
  });

  test("hot-path timestamps do not notify", async ({
    makeAgent,
    makeOrganization,
    makeVirtualApiKey,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const key = await makeVirtualApiKey(organization.id);
    const { flush, unlisten } = await listen();

    await db
      .update(schema.virtualApiKeysTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.virtualApiKeysTable.id, key.id));
    await db
      .update(schema.agentsTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.agentsTable.id, agent.id));

    expect(await flush()).toEqual([]);
    await unlisten();
  });
});
