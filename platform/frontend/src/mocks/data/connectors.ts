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
 * Ten completed content runs, six hours apart, matching the connector's
 * schedule. "No changes" is the ordinary steady state for a wiki that syncs
 * four times a day, so that is what most rows say.
 */
export const connectorRunsSeed = Array.from({ length: 10 }, (_, index) => {
  const startedAt = new Date(
    Date.parse(connectorSeed.lastSyncAt) - index * 6 * 60 * 60 * 1000,
  );
  const finishedAt = new Date(startedAt.getTime() + 2000);
  // The most recent run picked up a handful of edits; the rest were clean.
  const changed = index === 0;
  return {
    id: `run-${index}`,
    connectorId: CONNECTOR_ID,
    runType: "content",
    status: "completed",
    result: changed ? "changes" : "no_changes",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    documentsAdded: changed ? 3 : 0,
    documentsUpdated: changed ? 11 : 0,
    documentsDeleted: 0,
    documentsFailed: 0,
    error: null,
  };
});
