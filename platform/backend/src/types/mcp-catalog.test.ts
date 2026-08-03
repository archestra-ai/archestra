import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "@/database";
import {
  InsertInternalMcpCatalogSchema,
  PartialUpdateInternalMcpCatalogSchema,
} from "./mcp-catalog";

/**
 * The catalog write schemas are derived from the Drizzle table and then
 * SUBTRACT what must not be client-settable. That is a deny-list: every column
 * added to `internal_mcp_catalog` is writable through the API until someone
 * remembers to omit it, and forgetting is silent.
 *
 * It has been forgotten before — `deleted_at`, `deployment_name`, the preset
 * columns, the image-approval columns, and `latest_version` were each writable
 * until a fix landed. These tests turn the next omission into a failing build:
 * a new column must be classified as writable or listed below, on purpose.
 */
const SERVER_MANAGED_ON_INSERT = new Set([
  "createdAt",
  "updatedAt",
  // Soft-delete bookkeeping, written only by delete/restore.
  "deletedAt",
  // Tenancy + authorship are taken from the request context.
  "organizationId",
  "authorId",
  // Frozen K8s deployment identity, computed by the model / adopt pass.
  "deploymentName",
  // Head pointer into mcp_catalog_versions, forked by the version model.
  "latestVersion",
  // Optimistic-concurrency token; compared via expectedRevision, never assigned.
  "revision",
  // Removed preset feature; columns retained non-destructively.
  "parentCatalogItemId",
  "childName",
  "presetEntryId",
  "presetFieldValues",
  "presetSecretId",
  // Admin-managed image approval — a self-approve vector if writable.
  "catalogItemApprovalStatus",
  "catalogItemApprovalReason",
  "catalogItemApprovalReviewedBy",
  "catalogItemApprovalReviewedAt",
]);

const SERVER_MANAGED_ON_UPDATE = new Set([
  ...SERVER_MANAGED_ON_INSERT,
  "id",
  // Tenancy is locked after creation.
  "multitenant",
  // Clone lineage is locked after creation.
  "clonedFrom",
]);

describe("internal MCP catalog write schemas", () => {
  const columns = Object.keys(getTableColumns(schema.internalMcpCatalogTable));

  it("classifies every column as writable or server-managed on insert", () => {
    const writable = new Set(Object.keys(InsertInternalMcpCatalogSchema.shape));
    const unclassified = columns.filter(
      (c) => !writable.has(c) && !SERVER_MANAGED_ON_INSERT.has(c),
    );
    expect(unclassified).toEqual([]);
  });

  it("classifies every column as writable or server-managed on update", () => {
    const writable = new Set(
      Object.keys(PartialUpdateInternalMcpCatalogSchema.shape),
    );
    const unclassified = columns.filter(
      (c) => !writable.has(c) && !SERVER_MANAGED_ON_UPDATE.has(c),
    );
    expect(unclassified).toEqual([]);
  });

  it("keeps every server-managed column out of both write schemas", () => {
    const insertWritable = new Set(
      Object.keys(InsertInternalMcpCatalogSchema.shape),
    );
    const updateWritable = new Set(
      Object.keys(PartialUpdateInternalMcpCatalogSchema.shape),
    );
    expect(
      [...SERVER_MANAGED_ON_INSERT].filter((c) => insertWritable.has(c)),
    ).toEqual([]);
    expect(
      [...SERVER_MANAGED_ON_UPDATE].filter((c) => updateWritable.has(c)),
    ).toEqual([]);
  });
});
