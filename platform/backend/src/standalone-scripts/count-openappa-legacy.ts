// biome-ignore-all lint/suspicious/noConsole: standalone operator CLI — console for TTY UX
/**
 * Count the conversations each organization opened under the earlier policy
 * model, before an upgrade refuses them.
 *
 * A conversation that opened pinned to the policy it started under (before
 * live policy revisions, or while new sessions kept a policy snapshot) is a
 * legacy family. The next build refuses each one once and the user starts a
 * new conversation. The event log has no timestamp and its opening record can
 * be encrypted, so SQL alone cannot tell the kinds apart: this script opens
 * the runtime store the way the backend does and reads each root's opening.
 *
 * Per organization it prints the roots read, the legacy ones, the legacy ones
 * with a completed operation in the last 7 days, and the roots whose opening
 * is sealed with a conversation key this read does not hold. It only reads.
 *
 * Run from `backend/` against the deployment's database:
 *
 *   pnpm db:openappa-count-legacy
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import db, {
  getDatabaseConnectionString,
  initializeDatabase,
} from "@/database";
import {
  openappaOperationsTable,
  openappaSessionsTable,
} from "@/database/schemas";

async function main() {
  await initializeDatabase();
  const native = await import("@archestra/openappa-rs");
  const url = new URL(getDatabaseConnectionString());
  // pg ignores Prisma's legacy schema parameter; rust-postgres rejects it.
  url.searchParams.delete("schema");
  await native.initializeOpenappa(url.toString(), 2);

  const rows = await db
    .selectDistinct({
      organizationId: openappaSessionsTable.organizationId,
      root: openappaSessionsTable.root,
    })
    .from(openappaSessionsTable);
  const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * DAY_MS);
  const counts = new Map<string, Counts>();
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const kinds = await native.openappaRootKinds(chunk.map(({ root }) => root));
    const legacy = chunk.filter((_, index) => kinds[index] === "legacy");
    const active = new Set(
      legacy.length === 0
        ? []
        : (
            await db
              .selectDistinct({ root: openappaOperationsTable.root })
              .from(openappaOperationsTable)
              .where(
                and(
                  inArray(
                    openappaOperationsTable.root,
                    legacy.map(({ root }) => root),
                  ),
                  eq(openappaOperationsTable.status, "complete"),
                  gt(openappaOperationsTable.createdAt, since),
                ),
              )
          ).map(({ root }) => root),
    );
    chunk.forEach(({ organizationId, root }, index) => {
      const count = counts.get(organizationId) ?? {
        roots: 0,
        legacy: 0,
        legacyActive: 0,
        encrypted: 0,
      };
      count.roots += 1;
      if (kinds[index] === "legacy") count.legacy += 1;
      if (active.has(root)) count.legacyActive += 1;
      if (kinds[index] === "encrypted") count.encrypted += 1;
      counts.set(organizationId, count);
    });
  }

  if (counts.size === 0) {
    console.log("[openappa-count-legacy] No OpenAPPA conversations found.");
    return;
  }
  for (const [organizationId, count] of counts)
    console.log(
      `[openappa-count-legacy] organization ${organizationId}: ${count.roots} conversations, ${count.legacy} legacy, ${count.legacyActive} legacy with a completed operation in the last ${ACTIVE_WINDOW_DAYS} days, ${count.encrypted} encrypted (kind not readable without the conversation key)`,
    );
}

type Counts = {
  roots: number;
  legacy: number;
  legacyActive: number;
  encrypted: number;
};

const ACTIVE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Roots per runtime read and per `IN` list, well under the driver's parameter limit. */
const CHUNK = 500;

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[openappa-count-legacy] failed:", err);
    process.exit(1);
  });
