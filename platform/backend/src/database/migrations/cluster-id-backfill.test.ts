import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { seedDefaultCluster } from "@/database/seed-default-cluster";
import ClusterModel from "@/models/cluster";
import { describe, expect, test } from "@/test";

/**
 * F1 — Backfill of mcp_server.cluster_id (per spec
 * platform/specs/cluster-fixes/F1-sticky-cluster-id.md).
 *
 * Existing rows where cluster_id IS NULL must be backfilled at migration
 * time with the cluster they would have resolved to dynamically:
 *   - personal-scoped (owner_id IS NOT NULL, team_id IS NULL):
 *       → personal-default cluster if any, else default.
 *   - all other rows:
 *       → default cluster.
 *
 * The tests below locate the backfill migration SQL on disk and exercise
 * it against a PGlite DB that has been pre-seeded with rows that still
 * have cluster_id = NULL. Until the developer commits the migration,
 * locating the file fails — which is the intended RED-phase signal.
 */

const MIGRATIONS_DIR = path.join(__dirname);

/**
 * Find the migration file that backfills mcp_server.cluster_id. The Drizzle
 * file name is generated (e.g. `0NNN_<random_words>.sql`) so we identify it
 * by content: a data UPDATE on mcp_server.cluster_id sourced from the
 * cluster table. Throws if no such file exists yet — that's the RED state.
 */
function findBackfillMigrationSql(): string {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const contents = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const lower = contents.toLowerCase();
    if (
      lower.includes("update mcp_server") &&
      lower.includes("cluster_id") &&
      // Heuristic: backfill SQL is an UPDATE on mcp_server that targets rows
      // with cluster_id IS NULL and sources its replacement from the cluster
      // table (is_default or is_personal_default). Subqueries against the
      // cluster table are normal — do NOT exclude them.
      lower.includes("cluster_id is null") &&
      (lower.includes("is_default") || lower.includes("is_personal_default"))
    ) {
      return contents;
    }
  }

  throw new Error(
    "Could not find backfill migration for mcp_server.cluster_id under " +
      `${MIGRATIONS_DIR}. Expected a Drizzle migration whose body issues an ` +
      "UPDATE on mcp_server WHERE cluster_id IS NULL, sourced from the " +
      "cluster table (is_default / is_personal_default).",
  );
}

/**
 * Run only the data-migration UPDATE statements from the backfill SQL.
 * Schema changes (if any) are already applied by PGlite via setup.ts —
 * we only re-apply data-mutating statements so each test starts from a
 * known data state.
 */
async function runBackfillStatements() {
  const migrationSql = findBackfillMigrationSql();
  const rawStatements = migrationSql
    .split("--> statement-breakpoint")
    .flatMap((block) => block.split(";"))
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);

  const dataStatements = rawStatements.filter((s) =>
    s.toUpperCase().startsWith("UPDATE"),
  );

  for (const statement of dataStatements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

/**
 * Insert an mcp_server row directly so we control cluster_id (NULL) and
 * scope/owner/team flags exactly. Bypasses McpServerModel.create on
 * purpose — the model's create path is what fixes new rows; the migration
 * is what fixes legacy rows already on disk.
 */
async function insertLegacyServer(params: {
  catalogId: string;
  ownerId: string | null;
  teamId: string | null;
  scope: "personal" | "team" | "org";
  name?: string;
}) {
  const [row] = await db
    .insert(schema.mcpServersTable)
    .values({
      name: params.name ?? `legacy-${crypto.randomUUID().substring(0, 8)}`,
      serverType: "remote",
      catalogId: params.catalogId,
      ownerId: params.ownerId,
      teamId: params.teamId,
      scope: params.scope,
      // clusterId intentionally omitted → NULL, simulating legacy data.
    })
    .returning();
  // Defensive: explicitly NULL it in case the schema later defaults it.
  await db.execute(
    sql`UPDATE mcp_server SET cluster_id = NULL WHERE id = ${row.id}`,
  );
  return row;
}

async function getClusterId(serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ clusterId: schema.mcpServersTable.clusterId })
    .from(schema.mcpServersTable)
    .where(eq(schema.mcpServersTable.id, serverId));
  return row?.clusterId ?? null;
}

describe("F1 backfill: mcp_server.cluster_id", () => {
  test("personal server (owner set, team null) with personal-default present → backfilled to personal-default's id", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    await seedDefaultCluster();
    const personalDefault = await ClusterModel.create({
      name: "personal-default-fixture",
      isPersonalDefault: true,
    });

    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    const server = await insertLegacyServer({
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: null,
      scope: "personal",
    });

    // Pre-condition: legacy row really starts with cluster_id = NULL.
    expect(await getClusterId(server.id)).toBeNull();

    await runBackfillStatements();

    expect(await getClusterId(server.id)).toBe(personalDefault.id);
  });

  test("personal server with NO personal-default but a default present → backfilled to default cluster's id", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const def = await seedDefaultCluster();
    expect(await ClusterModel.getPersonalDefault()).toBeNull();

    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    const server = await insertLegacyServer({
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: null,
      scope: "personal",
    });
    expect(await getClusterId(server.id)).toBeNull();

    await runBackfillStatements();

    expect(await getClusterId(server.id)).toBe(def.id);
  });

  test("team server (team_id set) → backfilled to default cluster, NOT personal-default", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const def = await seedDefaultCluster();
    // Personal-default present too — team rows must still resolve to default.
    const personalDefault = await ClusterModel.create({
      name: "personal-default-fixture",
      isPersonalDefault: true,
    });

    const organization = await makeOrganization();
    const installer = await makeUser();
    await makeMember(installer.id, organization.id);
    const team = await makeTeam(organization.id, installer.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    const server = await insertLegacyServer({
      catalogId: catalog.id,
      ownerId: installer.id,
      teamId: team.id,
      scope: "team",
    });
    expect(await getClusterId(server.id)).toBeNull();

    await runBackfillStatements();

    const after = await getClusterId(server.id);
    expect(after).toBe(def.id);
    expect(after).not.toBe(personalDefault.id);
  });
});
