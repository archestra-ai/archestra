import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import db from "@/database";
import {
  createAgentToolsIndexes,
  createInteractionsIndexes,
  createMcpServerIndexes,
  dropLegacyPayloadTrgmIndexes,
  isModelHistoryIndexReady,
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
  const allAssignments = "agent_tools_tool_id_all_agent_id_idx";
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
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${allAssignments}"`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${pinned}"`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${unpinned}"`));
  });

  test("creates the full tool lookup and both partial indexes when missing", async () => {
    expect(await createAgentToolsIndexes(options)).toEqual({
      [allAssignments]: "created",
      [pinned]: "created",
      [unpinned]: "created",
    });

    expect(await indexDefinition(allAssignments)).toBe(
      `CREATE INDEX ${allAssignments} ON public.agent_tools USING btree (tool_id, agent_id)`,
    );
    expect(await indexDefinition(pinned)).toBe(
      `CREATE INDEX ${pinned} ON public.agent_tools USING btree (mcp_server_id, agent_id) WHERE (mcp_server_id IS NOT NULL)`,
    );
    expect(await indexDefinition(unpinned)).toBe(
      `CREATE INDEX ${unpinned} ON public.agent_tools USING btree (tool_id, agent_id) WHERE (mcp_server_id IS NULL)`,
    );
    expect(await advisoryLockCount()).toBe(0);
  });

  test("supports a tool lookup without a pinned or unpinned predicate", async () => {
    await createAgentToolsIndexes(options);

    // The review counts every assignment. Its query cannot use the existing
    // partial tool index because it does not constrain mcp_server_id.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(sql`
        EXPLAIN (FORMAT JSON)
        SELECT count(*) FROM agent_tools
        WHERE tool_id = '00000000-0000-4000-8000-000000000001'::uuid
      `);
    });
    expect(JSON.stringify(plan.rows)).toContain(allAssignments);
  });

  test("leaves valid indexes alone", async () => {
    await createAgentToolsIndexes(options);
    const allOid = await indexOid(allAssignments);
    const pinnedOid = await indexOid(pinned);
    const unpinnedOid = await indexOid(unpinned);

    expect(await createAgentToolsIndexes(options)).toEqual({
      [allAssignments]: "already_valid",
      [pinned]: "already_valid",
      [unpinned]: "already_valid",
    });
    expect(await indexOid(allAssignments)).toBe(allOid);
    expect(await indexOid(pinned)).toBe(pinnedOid);
    expect(await indexOid(unpinned)).toBe(unpinnedOid);
  });

  test.each([
    unpinned,
    allAssignments,
  ])("rebuilds %s after an interrupted build", async (indexName) => {
    await createAgentToolsIndexes(options);
    const pinnedOid = await indexOid(pinned);
    const invalidOid = await indexOid(indexName);
    // What a cancelled CREATE INDEX CONCURRENTLY leaves behind.
    await db.execute(
      sql`update pg_index set indisvalid = false where indexrelid = ${invalidOid}::oid`,
    );

    expect(await createAgentToolsIndexes(options)).toEqual({
      [allAssignments]: "already_valid",
      [pinned]: "already_valid",
      [unpinned]: "already_valid",
      [indexName]: "rebuilt_invalid",
    });
    expect(await indexOid(pinned)).toBe(pinnedOid);
    expect(await indexOid(indexName)).not.toBe(invalidOid);
    const rebuilt = await db.execute(
      sql`select indisvalid from pg_index where indexrelid = to_regclass(${indexName})`,
    );
    expect(rebuilt.rows[0]?.indisvalid).toBe(true);
  });

  test("leaves a partial index using the full lookup name alone", async () => {
    await db.execute(
      sql.raw(
        `CREATE INDEX "${allAssignments}" ON agent_tools (tool_id, agent_id) WHERE mcp_server_id IS NULL`,
      ),
    );
    const before = await indexDefinition(allAssignments);
    expect(await createAgentToolsIndexes(options)).toEqual({
      [allAssignments]: "unexpected_definition",
      [pinned]: "created",
      [unpinned]: "created",
    });
    expect(await indexDefinition(allAssignments)).toBe(before);
    expect(await advisoryLockCount()).toBe(0);
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
      [allAssignments]: "created",
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

  test("rebuilds the index when an interrupted build left it invalid", async () => {
    await createMcpServerIndexes(options);
    const oid = await indexOid(name);
    // What a cancelled CREATE INDEX CONCURRENTLY leaves behind.
    await db.execute(
      sql`update pg_index set indisvalid = false where indexrelid = ${oid}::oid`,
    );

    expect(await createMcpServerIndexes(options)).toEqual({
      [name]: "rebuilt_invalid",
    });
    expect(await indexOid(name)).not.toBe(oid);
    const rebuilt = await db.execute(
      sql`select indisvalid from pg_index where indexrelid = to_regclass(${name})`,
    );
    expect(rebuilt.rows[0]?.indisvalid).toBe(true);
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

describe("createInteractionsIndexes", () => {
  const name = "interactions_session_preview_missing_idx";
  const passthroughName = "interactions_passthrough_virtual_key_id_idx";
  const modelHistoryName = "interactions_model_created_at_idx";
  const mediaCostName = "interactions_media_cost_unavailable_idx";
  const options = {
    concurrently: false,
    client: {
      query: (text: string, values?: unknown[]) =>
        db.$client.query(text, values),
    },
  };

  beforeEach(async () => {
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${name}"`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${passthroughName}"`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${modelHistoryName}"`));
    await db.execute(sql.raw(`DROP INDEX IF EXISTS "${mediaCostName}"`));
  });

  test("creates the missing-preview index, then recognizes it on the next boot", async () => {
    expect(await createInteractionsIndexes(options)).toEqual({
      [name]: "created",
      [passthroughName]: "created",
      [mediaCostName]: "created",
      [modelHistoryName]: "created",
    });
    expect(await indexDefinition(name)).toBe(
      `CREATE INDEX ${name} ON public.interactions USING btree (created_at, id) WHERE ((session_preview IS NULL) AND (encrypted_chat_conversation_id IS NULL))`,
    );
    const oid = await indexOid(name);

    // A predicate that does not match what PostgreSQL prints back would read
    // as someone else's index here, and the index would never be maintained.
    expect(await createInteractionsIndexes(options)).toEqual({
      [name]: "already_valid",
      [passthroughName]: "already_valid",
      [mediaCostName]: "already_valid",
      [modelHistoryName]: "already_valid",
    });
    expect(await indexOid(name)).toBe(oid);
    expect(await advisoryLockCount()).toBe(0);
  });

  // The predicate must read back as Postgres prints it, or every boot would
  // find the index under an "unexpected" definition and never repair it.
  test("creates the passthrough key index, then leaves it alone", async () => {
    expect((await createInteractionsIndexes(options))[passthroughName]).toBe(
      "created",
    );
    expect(await indexDefinition(passthroughName)).toBe(
      `CREATE INDEX ${passthroughName} ON public.interactions USING btree (passthrough_virtual_key_id) WHERE (passthrough_virtual_key_id IS NOT NULL)`,
    );
    const oid = await indexOid(passthroughName);

    expect((await createInteractionsIndexes(options))[passthroughName]).toBe(
      "already_valid",
    );
    expect(await indexOid(passthroughName)).toBe(oid);
    expect(await advisoryLockCount()).toBe(0);
  });

  test("creates the media cost index, then leaves it alone", async () => {
    expect((await createInteractionsIndexes(options))[mediaCostName]).toBe(
      "created",
    );
    expect(await indexDefinition(mediaCostName)).toBe(
      `CREATE INDEX ${mediaCostName} ON public.interactions USING btree (created_at, id) WHERE (((response -> '__mediaUsage'::text) ->> 'costAvailable'::text) = 'false'::text)`,
    );
    const oid = await indexOid(mediaCostName);

    expect((await createInteractionsIndexes(options))[mediaCostName]).toBe(
      "already_valid",
    );
    expect(await indexOid(mediaCostName)).toBe(oid);
  });
});

describe("model history index", () => {
  const name = "interactions_model_created_at_idx";
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

  // Cost backfills refuse to run until this reports ready, so the INCLUDE list
  // must read back exactly as built or the feature would stay off forever.
  test("is built with its INCLUDE columns and then reported ready", async () => {
    expect(await isModelHistoryIndexReady()).toBe(false);

    expect((await createInteractionsIndexes(options))[name]).toBe("created");
    expect(await indexDefinition(name)).toBe(
      `CREATE INDEX ${name} ON public.interactions USING btree (model, created_at, id) INCLUDE (type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cost, billing_mode, user_id)`,
    );
    expect(await isModelHistoryIndexReady()).toBe(true);

    expect((await createInteractionsIndexes(options))[name]).toBe(
      "already_valid",
    );
  });

  test("an index under its name with other columns is not ready and is left alone", async () => {
    await db.execute(
      sql.raw(`CREATE INDEX "${name}" ON interactions (model, created_at)`),
    );

    expect(await isModelHistoryIndexReady()).toBe(false);
    expect((await createInteractionsIndexes(options))[name]).toBe(
      "unexpected_definition",
    );
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
