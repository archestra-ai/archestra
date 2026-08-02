import { vi } from "vitest";

// Separate file from soft-delete-purge-handler.test.ts: asserting on the
// skipped-rows warning needs the @/logging module mock, which would move the
// whole (mock-free, shared-worker) file to the isolated vitest project.
vi.mock("@/logging");

import { eq, inArray } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import { expect, test } from "@/test";
import { handleSoftDeletePurge } from "./soft-delete-purge-handler";

const DAY_MS = 24 * 60 * 60 * 1000;

test("a full batch of un-purgeable rows cannot starve purgeable rows behind it", async ({
  makeOrganization,
  makeInternalMcpCatalog,
  makeMcpServer,
}) => {
  const org = await makeOrganization();

  // 51 (> the sweep's batch size of 50) expired catalogs, each pinned by a
  // live install so hardDelete refuses them, all older than the purgeable
  // one. The pinned rows keep their deleted_at, so they occupy the front of
  // every scan; only the skip-count offset lets the sweep get past them.
  const pinnedIds: string[] = [];
  for (let i = 0; i < 51; i++) {
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    await makeMcpServer({ catalogId: catalog.id });
    pinnedIds.push(catalog.id);
  }
  // One shared timestamp: the scan must tie-break on id to page past them.
  await db
    .update(schema.internalMcpCatalogTable)
    .set({ deletedAt: new Date(Date.now() - 40 * DAY_MS) })
    .where(inArray(schema.internalMcpCatalogTable.id, pinnedIds));

  const purgeable = await makeInternalMcpCatalog({ organizationId: org.id });
  await db
    .update(schema.internalMcpCatalogTable)
    .set({ deletedAt: new Date(Date.now() - 35 * DAY_MS) })
    .where(eq(schema.internalMcpCatalogTable.id, purgeable.id));

  config.softDeleteRetention.enabled = true;
  config.softDeleteRetention.days = 30;

  await handleSoftDeletePurge();

  const [purgedRow] = await db
    .select({ id: schema.internalMcpCatalogTable.id })
    .from(schema.internalMcpCatalogTable)
    .where(eq(schema.internalMcpCatalogTable.id, purgeable.id));
  expect(purgedRow).toBeUndefined();

  const pinnedRows = await db
    .select({ id: schema.internalMcpCatalogTable.id })
    .from(schema.internalMcpCatalogTable)
    .where(inArray(schema.internalMcpCatalogTable.id, pinnedIds));
  expect(pinnedRows).toHaveLength(51);

  // The blockage is visible, not silent.
  expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
    expect.objectContaining({ entity: "internalMcpCatalog", skipped: 51 }),
    "soft-delete purge sweep: expired rows left in place (still referenced, restored mid-sweep, or errored)",
  );
});
