import { sql } from "drizzle-orm";
import db from "@/database";
import { seedDefaultCluster } from "@/database/seed-default-cluster";
import { describe, expect, test } from "@/test";

async function tableExists(tableName: string): Promise<boolean> {
  const result = await db.execute<{ exists: boolean }>(
    sql.raw(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '${tableName}'
      ) AS "exists";
    `),
  );
  return result.rows[0]?.exists ?? false;
}

async function getColumn(
  tableName: string,
  columnName: string,
): Promise<
  | {
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }
  | undefined
> {
  const result = await db.execute<{
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    sql.raw(`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = '${tableName}'
        AND column_name = '${columnName}';
    `),
  );
  return result.rows[0];
}

async function getForeignKey(
  tableName: string,
  columnName: string,
): Promise<
  | {
      foreign_table_name: string;
      foreign_column_name: string;
      delete_rule: string;
    }
  | undefined
> {
  const result = await db.execute<{
    foreign_table_name: string;
    foreign_column_name: string;
    delete_rule: string;
  }>(
    sql.raw(`
      SELECT
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = '${tableName}'
        AND kcu.column_name = '${columnName}';
    `),
  );
  return result.rows[0];
}

async function getPartialUniqueIndexDef(
  tableName: string,
  predicateNeedle: string,
): Promise<string | undefined> {
  const result = await db.execute<{ indexdef: string }>(
    sql.raw(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = '${tableName}'
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef ILIKE '%${predicateNeedle}%';
    `),
  );
  return result.rows[0]?.indexdef;
}

describe("0223 migration: cluster table", () => {
  test("creates the cluster table", async () => {
    await expect(tableExists("cluster")).resolves.toBe(true);
  });

  test("declares id as uuid primary key with default", async () => {
    const col = await getColumn("cluster", "id");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("uuid");
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).not.toBeNull();
  });

  test("declares name as text NOT NULL", async () => {
    const col = await getColumn("cluster", "name");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("text");
    expect(col?.is_nullable).toBe("NO");
  });

  test("declares namespace as text NULLABLE", async () => {
    const col = await getColumn("cluster", "namespace");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("text");
    expect(col?.is_nullable).toBe("YES");
  });

  test("declares kubeconfig_secret_id as uuid NULLABLE", async () => {
    const col = await getColumn("cluster", "kubeconfig_secret_id");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("uuid");
    expect(col?.is_nullable).toBe("YES");
  });

  test("declares load_from_cluster as boolean NOT NULL DEFAULT false", async () => {
    const col = await getColumn("cluster", "load_from_cluster");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("boolean");
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/false/i);
  });

  test("declares is_default as boolean NOT NULL DEFAULT false", async () => {
    const col = await getColumn("cluster", "is_default");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("boolean");
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/false/i);
  });

  test("declares is_personal_default as boolean NOT NULL DEFAULT false", async () => {
    const col = await getColumn("cluster", "is_personal_default");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("boolean");
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/false/i);
  });

  test("declares created_at and updated_at timestamps NOT NULL with defaults", async () => {
    const createdAt = await getColumn("cluster", "created_at");
    const updatedAt = await getColumn("cluster", "updated_at");
    expect(createdAt?.is_nullable).toBe("NO");
    expect(createdAt?.column_default).not.toBeNull();
    expect(updatedAt?.is_nullable).toBe("NO");
    expect(updatedAt?.column_default).not.toBeNull();
  });

  test("kubeconfig_secret_id has FK to secret(id) ON DELETE SET NULL", async () => {
    const fk = await getForeignKey("cluster", "kubeconfig_secret_id");
    expect(fk).toBeDefined();
    expect(fk?.foreign_table_name).toBe("secret");
    expect(fk?.foreign_column_name).toBe("id");
    expect(fk?.delete_rule).toBe("SET NULL");
  });

  test("partial unique index enforces single is_default = true row", async () => {
    const def = await getPartialUniqueIndexDef("cluster", "is_default");
    expect(def).toBeDefined();
    expect(def).toMatch(/WHERE/i);
    expect(def).toMatch(/is_default/);

    await db.execute(sql.raw(`DELETE FROM "cluster";`));

    await db.execute(
      sql.raw(`
        INSERT INTO "cluster" ("name", "is_default") VALUES ('a', true);
      `),
    );

    await expect(
      db.execute(
        sql.raw(`
          INSERT INTO "cluster" ("name", "is_default") VALUES ('b', true);
        `),
      ),
    ).rejects.toThrow();

    await db.execute(
      sql.raw(`
        INSERT INTO "cluster" ("name", "is_default") VALUES ('c', false);
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO "cluster" ("name", "is_default") VALUES ('d', false);
      `),
    );
  });

  test("partial unique index enforces single is_personal_default = true row", async () => {
    const def = await getPartialUniqueIndexDef(
      "cluster",
      "is_personal_default",
    );
    expect(def).toBeDefined();
    expect(def).toMatch(/WHERE/i);
    expect(def).toMatch(/is_personal_default/);

    await db.execute(sql.raw(`DELETE FROM "cluster";`));

    await db.execute(
      sql.raw(`
        INSERT INTO "cluster" ("name", "is_personal_default") VALUES ('a', true);
      `),
    );

    await expect(
      db.execute(
        sql.raw(`
          INSERT INTO "cluster" ("name", "is_personal_default") VALUES ('b', true);
        `),
      ),
    ).rejects.toThrow();
  });

  test("seedDefaultCluster bootstrap helper inserts a single default row named 'default'", async () => {
    await db.execute(sql.raw(`DELETE FROM "cluster";`));

    await seedDefaultCluster();

    const result = await db.execute<{
      name: string;
      is_default: boolean;
      load_from_cluster: boolean;
    }>(
      sql.raw(`
        SELECT name, is_default, load_from_cluster
        FROM "cluster"
        WHERE is_default = true;
      `),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.name).toBe("default");
    expect(result.rows[0]?.is_default).toBe(true);
  });

  test("seedDefaultCluster is idempotent (no duplicate default rows on re-run)", async () => {
    await db.execute(sql.raw(`DELETE FROM "cluster";`));

    await seedDefaultCluster();
    await seedDefaultCluster();

    const result = await db.execute<{ count: string }>(
      sql.raw(`
        SELECT COUNT(*)::text AS count FROM "cluster" WHERE is_default = true;
      `),
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  test("seedDefaultCluster handles race-lost path (default row pre-inserted by competing process)", async () => {
    // Another backend process won the race and committed the default-cluster
    // row before this process called the seed. The seed must NOT throw on the
    // partial unique index, must return the winning row, and the table must
    // end up with exactly one is_default = true row. PGLite's single-connection
    // setup can't honestly reproduce a between-SELECT-and-INSERT interleave, so
    // this test encodes the observable end-state contract.
    await db.execute(sql.raw(`DELETE FROM "cluster";`));

    await db.execute(
      sql.raw(`
        INSERT INTO "cluster" ("name", "namespace", "is_default")
        VALUES ('default', 'preexisting-ns', true);
      `),
    );

    const seeded = await seedDefaultCluster();

    expect(seeded).toBeDefined();
    expect(seeded?.name).toBe("default");
    expect(seeded?.namespace).toBe("preexisting-ns");
    expect(seeded?.isDefault).toBe(true);

    const countResult = await db.execute<{ count: string }>(
      sql.raw(`
        SELECT COUNT(*)::text AS count FROM "cluster" WHERE is_default = true;
      `),
    );
    expect(countResult.rows[0]?.count).toBe("1");
  });
});

describe("0223 migration: mcp_server.cluster_id FK", () => {
  test("declares mcp_server.cluster_id as uuid NULLABLE with no default", async () => {
    const col = await getColumn("mcp_server", "cluster_id");
    expect(col).toBeDefined();
    expect(col?.data_type).toBe("uuid");
    expect(col?.is_nullable).toBe("YES");
    expect(col?.column_default).toBeNull();
  });

  test("mcp_server.cluster_id has FK to cluster(id) ON DELETE SET NULL", async () => {
    const fk = await getForeignKey("mcp_server", "cluster_id");
    expect(fk).toBeDefined();
    expect(fk?.foreign_table_name).toBe("cluster");
    expect(fk?.foreign_column_name).toBe("id");
    expect(fk?.delete_rule).toBe("SET NULL");
  });

  test("deleting referenced cluster sets mcp_server.cluster_id to NULL (not cascade-delete)", async () => {
    await db.execute(sql.raw(`DELETE FROM "mcp_server";`));
    await db.execute(sql.raw(`DELETE FROM "cluster";`));
    await db.execute(sql.raw(`DELETE FROM "internal_mcp_catalog";`));

    const catalogResult = await db.execute<{ id: string }>(
      sql.raw(`
        INSERT INTO "internal_mcp_catalog"
          ("name", "server_type", "server_url", "description", "version")
        VALUES ('cat', 'local', 'http://x', 'd', '1')
        RETURNING id;
      `),
    );
    const catalogId = catalogResult.rows[0]?.id;
    expect(catalogId).toBeDefined();

    const clusterResult = await db.execute<{ id: string }>(
      sql.raw(`
        INSERT INTO "cluster" ("name") VALUES ('c1') RETURNING id;
      `),
    );
    const clusterId = clusterResult.rows[0]?.id;
    expect(clusterId).toBeDefined();

    const serverResult = await db.execute<{ id: string }>(
      sql.raw(`
        INSERT INTO "mcp_server"
          ("name", "catalog_id", "server_type", "cluster_id")
        VALUES ('s1', '${catalogId}', 'local', '${clusterId}')
        RETURNING id;
      `),
    );
    const serverId = serverResult.rows[0]?.id;
    expect(serverId).toBeDefined();

    const before = await db.execute<{ cluster_id: string | null }>(
      sql.raw(`SELECT cluster_id FROM "mcp_server" WHERE id = '${serverId}';`),
    );
    expect(before.rows[0]?.cluster_id).toBe(clusterId);

    await db.execute(
      sql.raw(`DELETE FROM "cluster" WHERE id = '${clusterId}';`),
    );

    const after = await db.execute<{
      id: string;
      cluster_id: string | null;
    }>(
      sql.raw(
        `SELECT id, cluster_id FROM "mcp_server" WHERE id = '${serverId}';`,
      ),
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.cluster_id).toBeNull();
  });

  test("no backfill: existing mcp_server rows keep cluster_id = NULL after migration", async () => {
    await db.execute(sql.raw(`DELETE FROM "mcp_server";`));
    await db.execute(sql.raw(`DELETE FROM "internal_mcp_catalog";`));

    const catalogResult = await db.execute<{ id: string }>(
      sql.raw(`
        INSERT INTO "internal_mcp_catalog"
          ("name", "server_type", "server_url", "description", "version")
        VALUES ('cat2', 'local', 'http://x', 'd', '1')
        RETURNING id;
      `),
    );
    const catalogId = catalogResult.rows[0]?.id;

    await db.execute(
      sql.raw(`
        INSERT INTO "mcp_server" ("name", "catalog_id", "server_type")
        VALUES ('preexisting', '${catalogId}', 'local');
      `),
    );

    const result = await db.execute<{ cluster_id: string | null }>(
      sql.raw(`SELECT cluster_id FROM "mcp_server";`),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.cluster_id).toBeNull();
  });
});
