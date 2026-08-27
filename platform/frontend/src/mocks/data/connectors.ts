/**
 * Seed data for the knowledge connector surfaces.
 *
 * The connector detail page is otherwise unreachable under MSW: the list page
 * gates the whole feature behind `enterpriseFeatures.knowledgeBase`, and every
 * route below it needs a connector that exists. These seeds make
 * `/knowledge/connectors/<id>` render its header, fact row and Sync Runs table
 * without a database.
 */

/** The seeded connector's id, so tests and links can address it directly. */
export const CONNECTOR_ID = "6f3a1c58-7c1e-4a0f-9c2b-9a1d5f0b7e11";

export const connectorSeed = {
  id: CONNECTOR_ID,
  name: "Engineering wiki",
  description:
    "Product specs, runbooks and architecture decision records for the platform teams.",
  connectorType: "confluence",
  enabled: true,
  schedule: "0 */6 * * *",
  lastSyncAt: "2026-08-27T02:00:24.000Z",
  lastSyncStatus: "success",
  lastPermissionSyncAt: "2026-08-27T02:04:11.000Z",
  lastPermissionSyncStatus: "success",
  permissionSyncIntervalSeconds: 1800,
  totalDocsIngested: 22921,
  visibility: "organization",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-08-27T02:00:24.000Z",
};

/**
 * Ten settled content runs, six hours apart, matching the connector's
 * schedule. The Result column derives "No changes" from a successful run that
 * ingested nothing, which is the ordinary steady state for a wiki syncing four
 * times a day, so that is what most rows say; the most recent one picked up a
 * few edits.
 */
export const connectorRunsSeed = Array.from({ length: 10 }, (_, index) => {
  const startedAt = new Date(
    Date.parse(connectorSeed.lastSyncAt) - index * 6 * 60 * 60 * 1000,
  );
  const ingested = index === 0 ? 14 : 0;
  return {
    id: `run-${index}`,
    connectorId: CONNECTOR_ID,
    runType: "content",
    status: "success",
    startedAt: startedAt.toISOString(),
    // `completedAt`, not `finishedAt`: the duration column measures an
    // unfinished run against now, so the wrong field name made every settled
    // run read as still running for hours.
    completedAt: new Date(startedAt.getTime() + 2000).toISOString(),
    documentsIngested: ingested,
    documentsProcessed: ingested,
    totalItems: connectorSeed.totalDocsIngested,
    error: null,
  };
});
