import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import db, { initializeDatabase, schema } from "@/database";
import ConversationModel from "@/models/conversation";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";

async function waitForLock(queryPattern: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await db.$client.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query ILIKE $1`,
      [queryPattern],
    );
    if (result.rowCount) return;
    await delay(10);
  }
  throw new Error(`Expected a waiting database operation: ${queryPattern}`);
}

test("model cleanup serializes with provider catalog refresh", {
  timeout: 30_000,
}, async () => {
  assert.ok(
    new URL(process.env.ARCHESTRA_DATABASE_URL ?? "").pathname.endsWith(
      "_test",
    ),
    "A migrated disposable *_test database is required",
  );
  await initializeDatabase();
  await OrganizationModel.getOrCreateDefaultOrganization();
  const model = await ModelModel.ensureModelExists(
    `cleanup-concurrency-${randomUUID()}`,
    "openai",
  );
  assert.ok(model);
  const gate = await db.$client.connect();
  let refresh: ReturnType<typeof ModelModel.bulkUpsert> | undefined;
  let removal: ReturnType<typeof ModelModel.deleteUnused> | undefined;
  try {
    // Pause the real refresh after its model row lock but before policy creation.
    // A database trigger makes the interleaving deterministic without mocking
    // either production transaction or its query execution.
    await gate.query("SELECT pg_advisory_lock(2149, 1)");
    await gate.query(`
      CREATE FUNCTION model_cleanup_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${model.id}'::uuid THEN
          PERFORM pg_advisory_xact_lock(2149, 1);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER model_cleanup_pause AFTER UPDATE ON models
        FOR EACH ROW EXECUTE FUNCTION model_cleanup_pause();
    `);
    refresh = ModelModel.bulkUpsert(
      [
        {
          externalId: model.externalId,
          provider: model.provider,
          modelId: model.modelId,
          inputModalities: null,
          outputModalities: null,
          promptPricePerToken: "0.000001",
          completionPricePerToken: "0.000002",
          lastSyncedAt: new Date(),
        },
      ],
      { fromProviderCatalog: true },
    );
    void refresh.catch(() => {});
    await waitForLock('%insert into "models"%');
    removal = ModelModel.deleteUnused(model.id);
    void removal.catch(() => {});
    // The new implementation waits on the catalog table lock; the old one
    // waits on the model row after acquiring the conflicting policy table lock.
    // Exclude the paused INSERT so both transactions have reached their gate.
    const deadline = Date.now() + 5000;
    let blockedRemoval = false;
    while (!blockedRemoval && Date.now() < deadline) {
      const result = await gate.query(`
        SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query ILIKE '%models%'
          AND query NOT ILIKE '%insert into%'
          AND pid <> pg_backend_pid()
      `);
      blockedRemoval = !!result.rowCount;
      if (!blockedRemoval) await delay(10);
    }
    assert.ok(blockedRemoval, "Cleanup must reach its database lock");
    await gate.query("SELECT pg_advisory_unlock(2149, 1)");
    const results = await Promise.allSettled([refresh, removal]);
    for (const result of results) {
      assert.equal(
        result.status,
        "fulfilled",
        result.status === "rejected"
          ? String(result.reason.cause ?? result.reason)
          : undefined,
      );
    }
    assert.deepEqual(await removal, { status: "ineligible" });
    const retained = await ModelModel.findById(model.id);
    assert.equal(retained?.promptPricePerToken, "0.000001000000");
    assert.equal(retained?.discoveredViaLlmProxy, false);
  } finally {
    await gate.query("SELECT pg_advisory_unlock(2149, 1)");
    await Promise.allSettled([refresh, removal]);
    await gate.query(`
      DROP TRIGGER IF EXISTS model_cleanup_pause ON models;
      DROP FUNCTION IF EXISTS model_cleanup_pause();
    `);
    await gate.query(
      "DELETE FROM resource_permission_policies WHERE resource = 'llmModel' AND scope = $1",
      [model.id],
    );
    await gate.query("DELETE FROM models WHERE id = $1", [model.id]);
    gate.release();
  }
});

test("model cleanup serializes with chat creation", {
  timeout: 30_000,
}, async () => {
  assert.ok(
    new URL(process.env.ARCHESTRA_DATABASE_URL ?? "").pathname.endsWith(
      "_test",
    ),
  );
  await initializeDatabase();
  const org = await OrganizationModel.getOrCreateDefaultOrganization();
  const userId = randomUUID();
  await db.insert(schema.usersTable).values({
    id: userId,
    name: "Cleanup test",
    email: `${userId}@example.com`,
  });
  await db.insert(schema.membersTable).values({
    id: randomUUID(),
    userId,
    organizationId: org.id,
    role: "admin",
    createdAt: new Date(),
  });
  const [agent] = await db
    .insert(schema.agentsTable)
    .values({ name: "Cleanup test", organizationId: org.id })
    .returning();
  const model = await ModelModel.ensureModelExists(
    `cleanup-chat-${randomUUID()}`,
    "openai",
  );
  assert.ok(model);
  const gate = await db.$client.connect();
  let creation: ReturnType<typeof ConversationModel.create> | undefined;
  let removal: ReturnType<typeof ModelModel.deleteUnused> | undefined;
  try {
    await gate.query("SELECT pg_advisory_lock(2149, 2)");
    await gate.query(`
      CREATE FUNCTION model_cleanup_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.model_id = '${model.id}'::uuid THEN
          PERFORM pg_advisory_xact_lock(2149, 2);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER zz_model_cleanup_pause AFTER INSERT ON conversations
        FOR EACH ROW EXECUTE FUNCTION model_cleanup_pause();
    `);
    creation = ConversationModel.create({
      userId,
      organizationId: org.id,
      agentId: agent.id,
      modelId: model.id,
    });
    void creation.catch(() => {});
    await waitForLock('%insert into "conversations"%');
    removal = ModelModel.deleteUnused(model.id);
    void removal.catch(() => {});
    await waitForLock("%models%for update%");
    await gate.query("SELECT pg_advisory_unlock(2149, 2)");
    const results = await Promise.allSettled([creation, removal]);
    for (const result of results) {
      assert.equal(
        result.status,
        "fulfilled",
        result.status === "rejected"
          ? String(result.reason.cause ?? result.reason)
          : undefined,
      );
    }
    assert.equal((await removal)?.status, "in_use");
    const rows = await gate.query(
      "SELECT model_id FROM conversations WHERE user_id = $1",
      [userId],
    );
    assert.equal(rows.rows[0]?.model_id, model.id);
    assert.ok(await ModelModel.findById(model.id));
  } finally {
    await gate.query("SELECT pg_advisory_unlock(2149, 2)");
    await Promise.allSettled([creation, removal]);
    await gate.query(
      `DROP TRIGGER IF EXISTS zz_model_cleanup_pause ON conversations; DROP FUNCTION IF EXISTS model_cleanup_pause();`,
    );
    await gate.query(
      "DELETE FROM resource_permission_policies WHERE resource = 'conversation' AND scope IN (SELECT id::text FROM conversations WHERE user_id = $1)",
      [userId],
    );
    await gate.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
    await gate.query("DELETE FROM agents WHERE id = $1", [agent.id]);
    await gate.query("DELETE FROM member WHERE user_id = $1", [userId]);
    await gate.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await gate.query(
      "DELETE FROM resource_permission_policies WHERE resource = 'llmModel' AND scope = $1",
      [model.id],
    );
    await gate.query("DELETE FROM models WHERE id = $1", [model.id]);
    gate.release();
  }
});

after(async () => {
  await db.$client.end();
});
