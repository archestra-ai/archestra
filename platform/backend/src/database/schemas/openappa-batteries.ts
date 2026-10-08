import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  BatteryAttachmentKind,
  BatteryCredentialBindings,
  BatteryInstallStatus,
  BatteryPackageFile,
} from "@/types/openappa-batteries";
import internalMcpCatalogTable from "./internal-mcp-catalog";
import organizationsTable from "./organization";

// A battery package an organization uploaded, content-addressed: a name may have several versions.
export const openappaBatteryPackagesTable = pgTable(
  "openappa_battery_packages",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    contentHash: text("content_hash").notNull(),
    files: jsonb().$type<BatteryPackageFile[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // An include entry spells a content hash: the bytes under one hash never change.
    uniqueIndex("openappa_battery_packages_org_hash_idx").on(
      table.organizationId,
      table.contentHash,
    ),
    // The panel lists a name's stored versions.
    index("openappa_battery_packages_org_name_list_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

// The derived read model of the declarations: one row per (organization, attachment, battery).
// An attachment is a catalog, a detected MCP server, or the organization itself for a battery
// made of annotators alone.
export const openappaBatteryInstallsTable = pgTable(
  "openappa_battery_installs",
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    batteryName: text("battery_name").notNull(),
    kind: text().$type<BatteryAttachmentKind>().notNull(),
    catalogId: uuid("catalog_id").references(() => internalMcpCatalogTable.id, {
      onDelete: "cascade",
    }),
    // A detected server's id, `<family>.<label>`; set for kind = "detected".
    detectedId: text("detected_id"),
    enabled: boolean().notNull().default(true),
    status: text()
      .$type<BatteryInstallStatus>()
      .notNull()
      .default("active" satisfies BatteryInstallStatus),
    // The package version the declaration spells; null for a bundled battery.
    packageHash: text("package_hash"),
    lastError: text("last_error"),
    credentialBindings: jsonb("credential_bindings")
      .$type<BatteryCredentialBindings>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One row per (organization, attachment, battery): the catalog or detected
    // column is set for its kind and null for the others, so nulls compare equal.
    unique("openappa_battery_installs_org_attachment_battery_uq")
      .on(
        table.organizationId,
        table.kind,
        table.catalogId,
        table.detectedId,
        table.batteryName,
      )
      .nullsNotDistinct(),
    check(
      "openappa_battery_installs_attachment_check",
      sql`(${table.kind} = 'catalog' AND ${table.catalogId} IS NOT NULL AND ${table.detectedId} IS NULL) OR (${table.kind} = 'detected' AND ${table.catalogId} IS NULL AND ${table.detectedId} IS NOT NULL) OR (${table.kind} = 'organization' AND ${table.catalogId} IS NULL AND ${table.detectedId} IS NULL)`,
    ),
    // Tool syncs and catalog deletes look installs up by catalog alone.
    index("openappa_battery_installs_catalog_idx").on(table.catalogId),
  ],
);

// The composed document the runtime opens: root policy + installed batteries, one per organization.
export const openappaEffectivePoliciesTable = pgTable(
  "openappa_effective_policies",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    contentHash: text("content_hash").notNull(),
    rootRevision: integer("root_revision").notNull(),
    installFingerprint: text("install_fingerprint").notNull(),
    compiledAt: timestamp("compiled_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  },
);
