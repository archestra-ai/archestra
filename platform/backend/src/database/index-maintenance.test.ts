import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import db from "@/database";
import {
  createAgentToolsIndexes,
  createMcpServerIndexes,
  dropLegacyPayloadTrgmIndexes,
} from "./index-maintenance";

async function indexExists(name: string): Promise<boolean> {
  const result = await db.execute(
    sql`select to_regclass(${name}) as index_oid`,
  );
  return result.rows[0]?.index_oid != null;
}

describe("dropLegacyPayloadTrgmIndexes", () => {
  test("drops the legacy payload indexes when present", async () => {
    // The test schema never creates the trgm indexes (pg_trgm is unavailable
    // under PGlite, and migration 0116 no longer creates them anyway), so
    // stand in plain indexes under the legacy names.
    await db.execute(
      sql.raw(
        'CREATE INDEX IF NOT EXISTS "interactions_request_trgm_idx" ON "interactions" (id)',
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE INDEX IF NOT EXISTS "interactions_response_trgm_idx" ON "interactions" (id)',
      ),
    );

    // concurrently: false — PGlite rejects DROP INDEX CONCURRENTLY; production
    // always uses the concurrent form (see the option's doc).
    await dropLegacyPayloadTrgmIndexes({ concurrently: false });

    expect(await indexExists("interactions_request_trgm_idx")).toBe(false);
    expect(await indexExists("interactions_response_trgm_idx")).toBe(false);
  });

  test("is a no-op when the indexes are already gone", async () => {
    await expect(
      dropLegacyPayloadTrgmIndexes({ concurrently: false }),
    ).resolves.toBeUndefined();
    expect(await indexExists("interactions_request_trgm_idx")).toBe(false);
  });
});

describe("createAgentToolsIndexes", () => {
  const pinned = "agent_tools_mcp_server_id_agent_id_idx";
  const unpinned = "agent_tools_tool_id_agent_id_idx";
  // concurrently: false — PGlite rejects the concurrent forms. The test
  // database client stands in for the dedicated production connection.
  const options = {
    concurrently: false,
    client: {
      query: (text: string, values?: unknown[]) =>
        db.$client.query(text, values),
    },
  };

  beforeEach(async () => {
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${pinned}"`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${unpinned}"`));
  });

  test("creates both partial indexes when missing", async () => {
    expect(await createAgentToolsIndexes(options)).toEqual({
      [pinned]: "created",
      [unpinned]: "created",
    });

    expect(await indexDefinition(pinned)).toBe(
      `CREATE INDEX ${pinned} ON public.agent_tools USING btree (mcp_server_id, agent_id) WHERE (mcp_server_id IS NOT NULL)`,
    );
    expect(await indexDefinition(unpinned)).toBe(
      `CREATE INDEX ${unpinned} ON public.agent_tools USING btree (tool_id, agent_id) WHERE (mcp_server_id IS NULL)`,
    );
    expect(await advisoryLockCount()).toBe(0);
  });

  test("leaves valid indexes alone", async () => {
    await createAgentToolsIndexes(options);
    const pinnedOid = await indexOid(pinned);
    const unpinnedOid = await indexOid(unpinned);

    expect(await createAgentToolsIndexes(options)).toEqual({
      [pinned]: "already_valid",
      [unpinned]: "already_valid",
    });
    expect(await indexOid(pinned)).toBe(pinnedOid);
    expect(await indexOid(unpinned)).toBe(unpinnedOid);
  });

  test("rebuilds a matching index left invalid by an interrupted build", async () => {
    await createAgentToolsIndexes(options);
    const pinnedOid = await indexOid(pinned);
    const unpinnedOid = await indexOid(unpinned);
    // What a cancelled CREATE INDEX CONCURRENTLY leaves behind.
    await db.execute(
      sql`update pg_index set indisvalid = false where indexrelid = ${unpinnedOid}::oid`,
    );

    expect(await createAgentToolsIndexes(options)).toEqual({
      [pinned]: "already_valid",
      [unpinned]: "rebuilt_invalid",
    });
    expect(await indexOid(pinned)).toBe(pinnedOid);
    expect(await indexOid(unpinned)).not.toBe(unpinnedOid);
    const rebuilt = await db.execute(
      sql`select indisvalid from pg_index where indexrelid = to_regclass(${unpinned})`,
    );
    expect(rebuilt.rows[0]?.indisvalid).toBe(true);
  });

  test.each([
    ["pinned", "other columns", `ON agent_tools (agent_id)`],
    ["pinned", "no predicate", `ON agent_tools (mcp_server_id, agent_id)`],
    [
      "pinned",
      "included column",
      `ON agent_tools (mcp_server_id) INCLUDE (agent_id) WHERE mcp_server_id IS NOT NULL`,
    ],
    [
      "unpinned",
      "opposite predicate",
      `ON agent_tools (tool_id, agent_id) WHERE mcp_server_id IS NOT NULL`,
    ],
  ])("leaves an unexpected %s definition alone and still builds the other index (%s)", async (taken, _, definition) => {
    const [takenName, otherName] =
      taken === "pinned" ? [pinned, unpinned] : [unpinned, pinned];
    await db.execute(sql.raw(`CREATE INDEX "${takenName}" ${definition}`));
    const before = await indexDefinition(takenName);

    expect(await createAgentToolsIndexes(options)).toEqual({
      [takenName]: "unexpected_definition",
      [otherName]: "created",
    });
    expect(await indexDefinition(takenName)).toBe(before);
    expect(await advisoryLockCount()).toBe(0);
  });
});

describe("createMcpServerIndexes", () => {
  const name = "mcp_server_catalog_id_live_idx";
  const options = {
    concurrently: false,
    client: {
      query: (text: string, values?: unknown[]) =>
        db.$client.query(text, values),
    },
  };

  beforeEach(async () => {
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
  });

  test("creates the live-install catalog index, then leaves it alone", async () => {
    expect(await createMcpServerIndexes(options)).toEqual({
      [name]: "created",
    });
    expect(await indexDefinition(name)).toBe(
      `CREATE INDEX ${name} ON public.mcp_server USING btree (catalog_id) WHERE (deleted_at IS NULL)`,
    );
    const oid = await indexOid(name);

    expect(await createMcpServerIndexes(options)).toEqual({
      [name]: "already_valid",
    });
    expect(await indexOid(name)).toBe(oid);
    expect(await advisoryLockCount()).toBe(0);
  });

  test("leaves an index of that name on another table alone", async () => {
    await db.execute(
      sql.raw(`CREATE INDEX "${name}" ON agent_tools (agent_id)`),
    );

    expect(await createMcpServerIndexes(options)).toEqual({
      [name]: "unexpected_definition",
    });
  });
});

async function indexOid(name: string): Promise<unknown> {
  const result = await db.execute(sql`select to_regclass(${name})::oid as oid`);
  return result.rows[0]?.oid;
}

async function indexDefinition(name: string): Promise<unknown> {
  const result = await db.execute(
    sql`select pg_get_indexdef(to_regclass(${name})) as definition`,
  );
  return result.rows[0]?.definition;
}

// Session advisory locks are reentrant, so a leaked lock would not show up as
// a failed retry on PGlite's single backend. Check the catalog instead.
async function advisoryLockCount(): Promise<unknown> {
  const result = await db.execute(
    sql`select count(*)::integer as count from pg_locks where locktype = 'advisory'`,
  );
  return result.rows[0]?.count;
}
