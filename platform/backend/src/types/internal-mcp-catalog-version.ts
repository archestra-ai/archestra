import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Canonical, hashable payload of a catalog version — the catalog item's
 * *config only*.
 *
 * Deliberately excluded (live-only state, never part of history):
 * - sharing: scope, teams, labels
 * - frozen identity: multitenant, deploymentName, clonedFrom
 * - ownership/lifecycle: organizationId, authorId, timestamps, deletedAt
 * - operational flags: catalogReinstallRequired, image-approval columns
 * - legacy preset columns (feature removed, retained inert)
 * - tool rows (discovered from the live server, not authored config)
 *
 * Secrets: only the raw row's secret-bundle IDs are captured (clientSecretId /
 * localConfigSecretId), never values — the snapshot builder re-reads the row
 * inside the fork transaction AND strips every plaintext secret field
 * defensively (stripAllPlaintextSecretFields), because writers have
 * historically leaked `expandSecrets`-materialized values into the row.
 * Because snapshots are deliberately lossy for secret material, a future
 * restore must re-source secrets from the live row/bundles, never from the
 * snapshot.
 *
 * Enum-ish fields are plain strings and config jsonb blobs are `unknown` on
 * purpose: snapshots are immutable historical data and must keep parsing after
 * an enum gains or loses values or a config shape evolves. For the same
 * reason, any field added later must be `.optional()` or `.nullable()` so
 * legacy rows still validate.
 *
 * Referenced entities are captured as id + human-readable name so history
 * stays legible after the referent is renamed or deleted.
 */
export const McpCatalogConfigSnapshotSchema = z.object({
  name: z.string(),
  serverType: z.string(),
  /**
   * The row's free-text `version` column — a user-supplied display label,
   * not this snapshot's history version number.
   */
  versionLabel: z.string().nullable(),
  description: z.string().nullable(),
  instructions: z.string().nullable(),
  repository: z.string().nullable(),
  installationCommand: z.string().nullable(),
  icon: z.string().nullable(),
  serverUrl: z.string().nullable(),
  docsUrl: z.string().nullable(),
  requiresAuth: z.boolean(),
  authDescription: z.string().nullable(),
  authFields: z.unknown(),
  userConfig: z.unknown(),
  oauthConfig: z.unknown(),
  enterpriseManagedConfig: z.unknown(),
  localConfig: z.unknown(),
  deploymentSpecYaml: z.string().nullable(),
  /** Secret-bundle IDs only — never secret material. */
  clientSecretId: z.string().nullable(),
  localConfigSecretId: z.string().nullable(),
  environment: z.object({ id: z.string(), name: z.string() }).nullable(),
  dynamicConnectionMcpServer: z
    .object({ id: z.string(), name: z.string() })
    .nullable(),
});

export type McpCatalogConfigSnapshot = z.infer<
  typeof McpCatalogConfigSnapshotSchema
>;

export const SelectInternalMcpCatalogVersionSchema = createSelectSchema(
  schema.internalMcpCatalogVersionsTable,
  { snapshot: McpCatalogConfigSnapshotSchema },
);

export type InternalMcpCatalogVersion = z.infer<
  typeof SelectInternalMcpCatalogVersionSchema
>;
