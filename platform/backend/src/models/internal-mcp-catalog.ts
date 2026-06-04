import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import {
  ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
  type InsertInternalMcpCatalog,
  type InternalMcpCatalog,
  type ListInternalMcpCatalog,
  type PresetFieldValues,
  type SecretValue,
  type UpdateInternalMcpCatalog,
  type UserConfigFieldDefault,
} from "@/types";
import McpCatalogLabelModel from "./mcp-catalog-label";
import McpCatalogTeamModel from "./mcp-catalog-team";
import McpServerModel from "./mcp-server";
import SecretModel from "./secret";
import ToolModel from "./tool";

/**
 * Data-access layer for `internal_mcp_catalog` — the org's private registry
 * of MCP server templates (root rows) and their child **presets** (rows
 * with a non-NULL `parentCatalogItemId` that inherit the parent's template
 * columns and overlay their own preset field values / secrets).
 *
 * Owns CRUD for both flavors, name composition for child rows
 * (`${parent.name}-${childName}`), persistence of preset field values and
 * the per-row preset secret bundle, validation of incoming values against
 * the parent's `userConfig` / `localConfig.environment` schema, and joins
 * against labels and team assignments. Mutations on a parent that need to
 * fan out to downstream installs go through the cascade helpers exposed
 * here.
 */
class InternalMcpCatalogModel {
  static async create(
    catalogItem: InsertInternalMcpCatalog,
    context?: { organizationId: string; authorId?: string },
  ): Promise<InternalMcpCatalog> {
    const { labels, teams, ...dbValues } = catalogItem;

    // Child catalog items ("presets") store the composed name
    // `${parent.name}-${childName}`; root items store name as submitted.
    if (dbValues.parentCatalogItemId) {
      if (!dbValues.childName) {
        throw new Error(
          "childName is required when parentCatalogItemId is set",
        );
      }
      const [parent] = await db
        .select({ name: schema.internalMcpCatalogTable.name })
        .from(schema.internalMcpCatalogTable)
        .where(
          eq(schema.internalMcpCatalogTable.id, dbValues.parentCatalogItemId),
        );
      if (!parent) {
        throw new Error(
          `Parent catalog item ${dbValues.parentCatalogItemId} not found`,
        );
      }
      dbValues.name = `${parent.name}-${dbValues.childName}`;
    } else {
      // Root rows never carry a childName.
      dbValues.childName = null;
    }

    const insertValues = {
      ...dbValues,
      ...(context?.organizationId
        ? { organizationId: context.organizationId }
        : {}),
      ...(context?.authorId ? { authorId: context.authorId } : {}),
    };

    let createdItem = (
      await db
        .insert(schema.internalMcpCatalogTable)
        .values(insertValues)
        .returning()
    )[0];

    if (labels && labels.length > 0) {
      await McpCatalogLabelModel.syncCatalogLabels(
        createdItem.id,
        labels.map((l) => ({ key: l.key, value: l.value })),
      );
    }

    if (teams && teams.length > 0) {
      await McpCatalogTeamModel.syncCatalogTeams(createdItem.id, teams);
    }

    const itemLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(
      createdItem.id,
    );
    const itemTeams = await McpCatalogTeamModel.getTeamDetailsForCatalog(
      createdItem.id,
    );

    // A clone copies the source's tools + guardrails as provisional rows, and
    // its secrets as independent copies (see cloneSecretsFromSource).
    if (createdItem.clonedFrom) {
      await ToolModel.cloneToolsAndPoliciesFromCatalog({
        sourceCatalogId: createdItem.clonedFrom,
        targetCatalogId: createdItem.id,
        targetCatalogName: createdItem.name,
      });
      createdItem =
        await InternalMcpCatalogModel.cloneSecretsFromSource(createdItem);
    }

    const result: InternalMcpCatalog = {
      ...createdItem,
      labels: itemLabels,
      teams: itemTeams,
    };
    await InternalMcpCatalogModel.populateAuthorNames([result]);
    return result;
  }

  static async findAll(options?: {
    expandSecrets?: boolean;
    userId?: string;
    isAdmin?: boolean;
    organizationId?: string;
    includeChildren?: boolean;
  }): Promise<ListInternalMcpCatalog[]> {
    const {
      expandSecrets = true,
      userId,
      isAdmin,
      organizationId,
      includeChildren = false,
    } = options ?? {};

    let dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>;

    const parentOnlyCondition = includeChildren
      ? undefined
      : isNull(schema.internalMcpCatalogTable.parentCatalogItemId);

    if (userId && !isAdmin && !organizationId) {
      return [];
    }

    if (userId && organizationId) {
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(
          userId,
          !!isAdmin,
          organizationId,
        );
      if (accessibleIds.length === 0) return [];
      const where = parentOnlyCondition
        ? and(
            inArray(schema.internalMcpCatalogTable.id, accessibleIds),
            parentOnlyCondition,
          )
        : inArray(schema.internalMcpCatalogTable.id, accessibleIds);
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(where)
        .orderBy(desc(schema.internalMcpCatalogTable.createdAt));
    } else {
      const baseQuery = db.select().from(schema.internalMcpCatalogTable);
      dbItems = await (parentOnlyCondition
        ? baseQuery.where(parentOnlyCondition)
        : baseQuery
      ).orderBy(desc(schema.internalMcpCatalogTable.createdAt));
    }

    const catalogItems =
      await InternalMcpCatalogModel.attachListMetadata(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    await InternalMcpCatalogModel.populateAuthorNames(catalogItems);

    return catalogItems;
  }

  static async searchByQuery(
    query: string,
    options?: {
      expandSecrets?: boolean;
      userId?: string;
      isAdmin?: boolean;
      organizationId?: string;
      includeChildren?: boolean;
    },
  ): Promise<ListInternalMcpCatalog[]> {
    const {
      expandSecrets = true,
      userId,
      isAdmin,
      organizationId,
      includeChildren = false,
    } = options ?? {};

    let dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>;

    const baseSearchCondition = or(
      ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
      ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
    );

    const searchCondition = includeChildren
      ? baseSearchCondition
      : and(
          baseSearchCondition,
          isNull(schema.internalMcpCatalogTable.parentCatalogItemId),
        );

    if (userId && !isAdmin && !organizationId) {
      return [];
    }

    if (userId && organizationId) {
      const accessibleIds =
        await McpCatalogTeamModel.getUserAccessibleCatalogIds(
          userId,
          !!isAdmin,
          organizationId,
        );
      if (accessibleIds.length === 0) return [];
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(
          and(
            inArray(schema.internalMcpCatalogTable.id, accessibleIds),
            searchCondition,
          ),
        );
    } else {
      dbItems = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(searchCondition);
    }

    const catalogItems =
      await InternalMcpCatalogModel.attachListMetadata(dbItems);

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets(catalogItems);
    }

    await InternalMcpCatalogModel.populateAuthorNames(catalogItems);

    return catalogItems;
  }

  /**
   * Return the singular catalog shape. Do not add toolCount here: it is list
   * metadata used by registry/card UIs and would require an otherwise-unused
   * COUNT(*) on runtime paths that fetch one catalog item by id.
   */
  static async findById(
    id: string,
    options?: {
      expandSecrets?: boolean;
      userId?: string;
      isAdmin?: boolean;
      organizationId?: string;
    },
  ): Promise<InternalMcpCatalog | null> {
    const {
      expandSecrets = true,
      userId,
      isAdmin,
      organizationId,
    } = options ?? {};

    if (userId && !isAdmin && !organizationId) {
      return null;
    }

    if (userId && organizationId) {
      const hasAccess = await McpCatalogTeamModel.userHasCatalogAccess(
        userId,
        id,
        !!isAdmin,
        organizationId,
      );
      if (!hasAccess) return null;
    }

    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(id);
    const catalogItem: InternalMcpCatalog = {
      ...dbItem,
      labels,
      teams,
    };

    if (expandSecrets) {
      await InternalMcpCatalogModel.expandSecrets([catalogItem]);
    }

    await InternalMcpCatalogModel.populateAuthorNames([catalogItem]);

    return catalogItem;
  }

  /**
   * Find catalog item by ID with all secrets resolved to actual values.
   * Use this for runtime flows (OAuth, MCP server startup).
   */
  static async findByIdWithResolvedSecrets(
    id: string,
  ): Promise<InternalMcpCatalog | null> {
    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(id);
    const catalogItem: InternalMcpCatalog = {
      ...dbItem,
      labels,
      teams,
    };

    await InternalMcpCatalogModel.expandSecretsAndAlwaysResolveValues([
      catalogItem,
    ]);

    return catalogItem;
  }

  static async findByEnvironmentId(
    environmentId: string,
  ): Promise<{ id: string; multitenant: boolean }[]> {
    return db
      .select({
        id: schema.internalMcpCatalogTable.id,
        multitenant: schema.internalMcpCatalogTable.multitenant,
      })
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.environmentId, environmentId),
          eq(schema.internalMcpCatalogTable.serverType, "local"),
        ),
      );
  }

  /**
   * Batch fetch multiple catalog items by IDs.
   * Returns a Map of catalog ID to catalog item.
   */
  static async getByIds(
    ids: string[],
  ): Promise<Map<string, ListInternalMcpCatalog>> {
    if (ids.length === 0) {
      return new Map();
    }

    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, ids));

    const catalogItems =
      await InternalMcpCatalogModel.attachListMetadata(dbItems);

    const result = new Map<string, ListInternalMcpCatalog>();
    for (const item of catalogItems) {
      result.set(item.id, item);
    }

    return result;
  }

  static async findByName(
    name: string,
    options?: { organizationId?: string },
  ): Promise<InternalMcpCatalog | null> {
    const whereCondition = options?.organizationId
      ? and(
          eq(schema.internalMcpCatalogTable.name, name),
          eq(
            schema.internalMcpCatalogTable.organizationId,
            options.organizationId,
          ),
        )
      : eq(schema.internalMcpCatalogTable.name, name);

    const [dbItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(whereCondition);

    if (!dbItem) {
      return null;
    }

    const labels = await McpCatalogLabelModel.getLabelsForCatalogItem(
      dbItem.id,
    );
    const teams = await McpCatalogTeamModel.getTeamDetailsForCatalog(dbItem.id);
    return { ...dbItem, labels, teams };
  }

  static async findByNameForAudit(
    name: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const item = await InternalMcpCatalogModel.findByName(name, {
      organizationId,
    });
    if (!item) return null;
    return InternalMcpCatalogModel.findByIdForAudit(item.id, organizationId);
  }

  static async update(
    id: string,
    catalogItem: Partial<UpdateInternalMcpCatalog>,
  ): Promise<InternalMcpCatalog | null> {
    const { labels, teams, ...dbValues } = catalogItem;

    // Name immutability: matches the existing UI-enforced posture and avoids
    // cascading rename to k8s deployment names and pre-slugified tool rows.
    if (dbValues.name !== undefined || dbValues.childName !== undefined) {
      const [existing] = await db
        .select({
          name: schema.internalMcpCatalogTable.name,
          childName: schema.internalMcpCatalogTable.childName,
        })
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, id));
      if (existing) {
        if (dbValues.name !== undefined && dbValues.name !== existing.name) {
          throw new Error("Catalog item name cannot be changed after creation");
        }
        if (
          dbValues.childName !== undefined &&
          dbValues.childName !== existing.childName
        ) {
          throw new Error("Preset childName cannot be changed after creation");
        }
      }
      delete dbValues.name;
      delete dbValues.childName;
    }

    let dbItem: typeof schema.internalMcpCatalogTable.$inferSelect | undefined;

    if (Object.keys(dbValues).length > 0) {
      [dbItem] = await db
        .update(schema.internalMcpCatalogTable)
        .set(dbValues)
        .where(eq(schema.internalMcpCatalogTable.id, id))
        .returning();
    } else {
      [dbItem] = await db
        .select()
        .from(schema.internalMcpCatalogTable)
        .where(eq(schema.internalMcpCatalogTable.id, id));
    }

    if (!dbItem) {
      return null;
    }

    if (labels !== undefined) {
      await McpCatalogLabelModel.syncCatalogLabels(
        id,
        labels.map((l) => ({ key: l.key, value: l.value })),
      );
    }

    if (teams !== undefined) {
      await McpCatalogTeamModel.syncCatalogTeams(id, teams);
    }

    const itemLabels = await McpCatalogLabelModel.getLabelsForCatalogItem(id);
    const itemTeams = await McpCatalogTeamModel.getTeamDetailsForCatalog(id);
    const result: InternalMcpCatalog = {
      ...dbItem,
      labels: itemLabels,
      teams: itemTeams,
    };
    await InternalMcpCatalogModel.populateAuthorNames([result]);
    return result;
  }

  /**
   * List child catalog items ("presets") for a given parent.
   *
   * Mirrors the catalog list endpoint: secrets are NOT expanded, so the
   * preset secret bag's plaintext values never reach the wire. Callers that
   * need to know whether secret-typed preset fields are filled use the
   * `presetSecretId != null` heuristic (same pattern as the install dialog's
   * preset-fallback-fields).
   */
  static async findChildren(parentId: string): Promise<InternalMcpCatalog[]> {
    const dbItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.parentCatalogItemId, parentId))
      .orderBy(asc(schema.internalMcpCatalogTable.createdAt));

    return InternalMcpCatalogModel.attachListMetadata(dbItems);
  }

  /**
   * Compute the set of field keys (env-var keys + userConfig field names)
   * that the parent currently exposes as `promptOnPreset: true`. Used by
   * both the strict validator and the lenient filter below.
   */
  static getPresetScopedKeys(parent: InternalMcpCatalog): Set<string> {
    const keys = new Set<string>();
    for (const [key, field] of Object.entries(parent.userConfig ?? {})) {
      if (field.promptOnPreset) keys.add(key);
    }
    for (const env of parent.localConfig?.environment ?? []) {
      if (env.promptOnPreset) keys.add(env.key);
    }
    return keys;
  }

  /**
   * Validate a `presetFieldValues` payload against a parent's currently
   * preset-scoped fields. Only fields flagged `promptOnPreset: true` are
   * allowed; throws an Error listing offenders when any other key is present.
   *
   * Use for *create-time* paths where a non-preset key in the payload almost
   * certainly indicates a typo or stale frontend that should fail loudly:
   *   - POST /api/internal_mcp_catalog/:id/children (createChild)
   *   - POST /api/mcp_server (install — frontend builds payload from current scope)
   *
   * Do NOT use for PATCH update on existing children — those routes must
   * tolerate orphan keys left over from past scope flips. See
   * `filterFieldValuesToPresetScope` below.
   */
  static validateFieldValuesAgainstCatalog(
    parent: InternalMcpCatalog,
    fieldValues: PresetFieldValues | undefined,
  ): void {
    if (!fieldValues) return;
    const presetKeys = InternalMcpCatalogModel.getPresetScopedKeys(parent);
    const offenders = Object.keys(fieldValues).filter(
      (key) => !presetKeys.has(key),
    );
    if (offenders.length > 0) {
      throw new Error(
        `Fields not configured for preset overrides: ${offenders.join(", ")}`,
      );
    }
  }

  /**
   * Return a sanitized copy of `fieldValues` that contains only keys
   * currently flagged `promptOnPreset: true` on the parent. Keys that are no
   * longer preset-scoped (orphans left by a past scope flip on the parent —
   * the cascade syncs the parent's localConfig template down but does not
   * scrub children's `preset_field_values` jsonb) are silently dropped.
   *
   * Use for *update* paths on existing children — when an admin opens the
   * preset editor the frontend copies the row's full presetFieldValues into
   * local state and re-sends them on save, so without this filter every
   * "Save" after a parent scope flip would 400 and silently drop the user's
   * new value (PR #4402, user-reported).
   *
   * As a beneficial side effect, every successful PATCH that round-trips
   * through this filter garbage-collects the orphans from the row's jsonb.
   */
  static filterFieldValuesToPresetScope(
    parent: InternalMcpCatalog,
    fieldValues: PresetFieldValues | undefined,
  ): PresetFieldValues {
    if (!fieldValues) return {};
    const presetKeys = InternalMcpCatalogModel.getPresetScopedKeys(parent);
    const filtered: PresetFieldValues = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(fieldValues)) {
      if (presetKeys.has(key)) {
        filtered[key] = value;
      } else {
        dropped.push(key);
      }
    }
    if (dropped.length > 0) {
      logger.info(
        { catalogId: parent.id, droppedKeys: dropped },
        "Dropped orphan preset keys from PATCH payload (no longer promptOnPreset on parent)",
      );
    }
    return filtered;
  }

  /**
   * Secret ownership when deleting a row:
   *   - clientSecretId / localConfigSecretId are owned by the parent row.
   *     Children store the same UUID for read-path convenience but do not own
   *     the bag, so a child delete must leave it alone.
   *   - presetSecretId is per-row: parent has its own default-preset bag;
   *     each child has its own overlay bag.
   *
   * Therefore deleting a child only removes the child's presetSecretId;
   * deleting a parent removes the parent-owned bags plus every child's
   * presetSecretId. Centralizing this here means every caller — the catalog
   * DELETE routes and McpPresetEntryModel.delete (which removes per-entry
   * catalog rows) — gets the cleanup automatically.
   */
  static async delete(id: string): Promise<boolean> {
    const row = await InternalMcpCatalogModel.findSecretReferences(id);
    if (!row) return false;

    // Cleanup mcp server installations across the catalog item and it's children (presets), if any.
    const children = await InternalMcpCatalogModel.findChildren(id);
    const catalogIds = [id, ...children.map((c) => c.id)];

    for (const catalogId of catalogIds) {
      const servers = await McpServerModel.findByCatalogId(catalogId);
      // Deleting each server cascades its tools.
      for (const server of servers) {
        await McpServerModel.delete(server.id);
      }
    }

    const secretIds = new Set<string>();
    if (row.parentCatalogItemId === null) {
      if (row.clientSecretId) secretIds.add(row.clientSecretId);
      if (row.localConfigSecretId) secretIds.add(row.localConfigSecretId);
      if (row.presetSecretId) secretIds.add(row.presetSecretId);
      for (const child of children) {
        if (child.presetSecretId) secretIds.add(child.presetSecretId);
      }
    } else if (row.presetSecretId) {
      secretIds.add(row.presetSecretId);
    }

    for (const secretId of secretIds) {
      await secretManager().deleteSecret(secretId);
    }

    const deletedRows = await db
      .delete(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id))
      .returning({ id: schema.internalMcpCatalogTable.id });

    return deletedRows.length > 0;
  }

  // ===== Private methods =====

  /**
   * Lean lookup used by `delete` to gather the secret-ownership context
   * (clientSecretId / localConfigSecretId / presetSecretId / parent flag)
   * without expanding the row's full secret bags.
   */
  private static async findSecretReferences(id: string): Promise<{
    clientSecretId: string | null;
    localConfigSecretId: string | null;
    presetSecretId: string | null;
    parentCatalogItemId: string | null;
  } | null> {
    const [row] = await db
      .select({
        clientSecretId: schema.internalMcpCatalogTable.clientSecretId,
        localConfigSecretId: schema.internalMcpCatalogTable.localConfigSecretId,
        presetSecretId: schema.internalMcpCatalogTable.presetSecretId,
        parentCatalogItemId: schema.internalMcpCatalogTable.parentCatalogItemId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));
    return row ?? null;
  }

  /**
   * Copy the clone source's secrets onto the clone, per key. Inherited keys
   * fill in only what the create payload did not already supply, so a value the
   * user entered while cloning wins over the source's. Returns the row with any
   * new secret FK ids applied.
   */
  private static async cloneSecretsFromSource(
    clone: typeof schema.internalMcpCatalogTable.$inferSelect,
  ): Promise<typeof schema.internalMcpCatalogTable.$inferSelect> {
    if (!clone.clonedFrom) return clone;

    const [source] = await db
      .select({
        clientSecretId: schema.internalMcpCatalogTable.clientSecretId,
        localConfigSecretId: schema.internalMcpCatalogTable.localConfigSecretId,
        presetSecretId: schema.internalMcpCatalogTable.presetSecretId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, clone.clonedFrom));
    if (!source) return clone;

    const updates: Partial<{
      clientSecretId: string;
      localConfigSecretId: string;
      presetSecretId: string;
    }> = {};

    const clientSecretId = await InternalMcpCatalogModel.cloneSecretSlot({
      sourceSecretId: source.clientSecretId,
      cloneSecretId: clone.clientSecretId,
      name: `${clone.name}-oauth-client-secret`,
    });
    if (clientSecretId) updates.clientSecretId = clientSecretId;

    const localConfigSecretId = await InternalMcpCatalogModel.cloneSecretSlot({
      sourceSecretId: source.localConfigSecretId,
      cloneSecretId: clone.localConfigSecretId,
      name: `${clone.name}-local-config-env`,
    });
    if (localConfigSecretId) updates.localConfigSecretId = localConfigSecretId;

    const presetSecretId = await InternalMcpCatalogModel.cloneSecretSlot({
      sourceSecretId: source.presetSecretId,
      cloneSecretId: clone.presetSecretId,
      name: `${clone.name}-preset-secrets`,
    });
    if (presetSecretId) updates.presetSecretId = presetSecretId;

    if (Object.keys(updates).length === 0) return clone;

    const [updated] = await db
      .update(schema.internalMcpCatalogTable)
      .set(updates)
      .where(eq(schema.internalMcpCatalogTable.id, clone.id))
      .returning();
    return updated ?? clone;
  }

  /**
   * Reconcile one secret slot of a clone against its source. Returns a new
   * secret id to write on the clone, or null if the clone's FK is unchanged
   * (it already had its own secret, or there is nothing to inherit).
   *
   * - Clone already has a secret (create payload supplied values): merge in the
   *   source keys it is missing, so per-key the user's value wins. The clone
   *   keeps its own secret row, so no FK change.
   * - Clone has none: duplicate the whole source bag into a new entry.
   */
  private static async cloneSecretSlot(params: {
    sourceSecretId: string | null;
    cloneSecretId: string | null;
    name: string;
  }): Promise<string | null> {
    const { sourceSecretId, cloneSecretId, name } = params;
    const source =
      await InternalMcpCatalogModel.readClonableSecret(sourceSecretId);
    if (!source) return null;

    if (cloneSecretId) {
      const cloneBag =
        (await secretManager().getSecret(cloneSecretId))?.secret ?? {};
      const merged: SecretValue = { ...cloneBag };
      let added = false;
      for (const [key, value] of Object.entries(source.bag)) {
        if (!(key in cloneBag)) {
          merged[key] = value;
          added = true;
        }
      }
      if (added) await secretManager().updateSecret(cloneSecretId, merged);
      return null;
    }

    if (Object.keys(source.bag).length === 0) return null;
    if (source.isVault) {
      return (await secretManager().createSecret(source.bag, name)).id;
    }
    const copy = await SecretModel.create({
      name,
      secret: source.bag,
      isVault: false,
      isByosVault: false,
    });
    return copy.id;
  }

  /**
   * Resolve a source secret's value bag for cloning, or null if missing or
   * BYOS-backed. BYOS secrets store `path#key` references into the customer's
   * own vault; copying or resolving them would either share or materialize a
   * secret we don't own, so they are skipped. Archestra-managed Vault secrets
   * are read through secretManager() so the clone copy is written back to Vault
   * rather than the DB; plain DB secrets carry their decrypted bag.
   */
  private static async readClonableSecret(
    secretId: string | null,
  ): Promise<{ bag: SecretValue; isVault: boolean } | null> {
    if (!secretId) return null;
    const source = await SecretModel.findById(secretId);
    if (!source || source.isByosVault) return null;
    if (source.isVault) {
      const resolved = await secretManager().getSecret(secretId);
      if (!resolved) return null;
      return { bag: resolved.secret, isVault: true };
    }
    return { bag: source.secret, isVault: false };
  }

  /**
   * Expands secrets and adds them to the catalog items, mutating the items.
   * For BYOS secrets (isByosVault=true), returns vault references / paths as-is.
   * For non-BYOS secrets, resolves actual values via secretManager().
   */
  private static async expandSecrets(
    catalogItems: InternalMcpCatalog[],
  ): Promise<void> {
    // Collect all unique secret IDs
    const secretIds = new Set<string>();
    for (const item of catalogItems) {
      if (item.clientSecretId) secretIds.add(item.clientSecretId);
      if (item.localConfigSecretId) secretIds.add(item.localConfigSecretId);
      if (item.presetSecretId) secretIds.add(item.presetSecretId);
    }

    if (secretIds.size === 0) return;

    // Fetch raw secret records e.g. vault paths, not resolved to actual value)
    const unresolvedSecretPromises = Array.from(secretIds).map((id) =>
      SecretModel.findById(id).then((secret) => [id, secret] as const),
    );
    const unresolvedSecretEntries = await Promise.all(unresolvedSecretPromises);
    const unresolvedSecretMap = new Map(
      unresolvedSecretEntries.filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );

    // For non-BYOS secrets, resolve them using secretManager
    const nonByosSecretIds = Array.from(secretIds).filter(
      (id) => !unresolvedSecretMap.get(id)?.isByosVault,
    );
    const resolvedSecretPromises = nonByosSecretIds.map((id) =>
      secretManager()
        .getSecret(id)
        .then((secret) => [id, secret] as const),
    );
    const resolvedSecretEntries = await Promise.all(resolvedSecretPromises);
    const resolvedSecretMap = new Map(
      resolvedSecretEntries.filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );

    // Enrich each catalog item
    for (const catalogItem of catalogItems) {
      // Enrich OAuth client_secret
      if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.clientSecretId,
        );
        // For BYOS: use raw vault reference, for non-BYOS: use resolved value
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.clientSecretId);
        const value = secret?.secret.client_secret;
        if (value) {
          catalogItem.oauthConfig.client_secret = String(value);
        }
      }

      if (catalogItem.clientSecretId && catalogItem.enterpriseManagedConfig) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.clientSecretId,
        );
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.clientSecretId);
        const value =
          secret?.secret[ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY];
        if (value) {
          catalogItem.enterpriseManagedConfig.clientSecretOverride =
            String(value);
        }
      }

      // Enrich local config secret env vars
      if (
        catalogItem.localConfigSecretId &&
        catalogItem.localConfig?.environment
      ) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.localConfigSecretId,
        );
        // For BYOS: use raw vault reference, for non-BYOS: use resolved value
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.localConfigSecretId);
        if (secret) {
          for (const envVar of catalogItem.localConfig.environment) {
            const value = secret.secret[envVar.key];
            if (envVar.type === "secret" && value) {
              envVar.value = String(value);
            }
          }
        }
      }

      // Enrich preset secret values (merge into presetFieldValues)
      if (catalogItem.presetSecretId) {
        const unresolvedSecret = unresolvedSecretMap.get(
          catalogItem.presetSecretId,
        );
        const secret = unresolvedSecret?.isByosVault
          ? unresolvedSecret
          : resolvedSecretMap.get(catalogItem.presetSecretId);
        if (secret) {
          catalogItem.presetFieldValues = {
            ...catalogItem.presetFieldValues,
            ...(secret.secret as Record<string, UserConfigFieldDefault>),
          };
        }
      }
    }
  }

  /**
   * Always resolves all secrets to their actual values.
   * Use this for runtime flows (OAuth, MCP server startup) that need real secret values.
   */
  private static async expandSecretsAndAlwaysResolveValues(
    catalogItems: InternalMcpCatalog[],
  ): Promise<void> {
    const secretIds = new Set<string>();
    for (const item of catalogItems) {
      if (item.clientSecretId) secretIds.add(item.clientSecretId);
      if (item.localConfigSecretId) secretIds.add(item.localConfigSecretId);
      if (item.presetSecretId) secretIds.add(item.presetSecretId);
    }

    if (secretIds.size === 0) return;

    // Always resolve using secretManager (resolves BYOS vault references to actual values)
    const secretPromises = Array.from(secretIds).map((id) =>
      secretManager()
        .getSecret(id)
        .then((secret) => [id, secret] as const),
    );
    const secretEntries = await Promise.all(secretPromises);
    const secretMap = new Map(
      secretEntries.filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          entry[1] !== null,
      ),
    );

    for (const catalogItem of catalogItems) {
      if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
        const secret = secretMap.get(catalogItem.clientSecretId);
        const value = secret?.secret.client_secret;
        if (value) {
          catalogItem.oauthConfig.client_secret = String(value);
        }
      }

      if (catalogItem.clientSecretId && catalogItem.enterpriseManagedConfig) {
        const secret = secretMap.get(catalogItem.clientSecretId);
        const value =
          secret?.secret[ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY];
        if (value) {
          catalogItem.enterpriseManagedConfig.clientSecretOverride =
            String(value);
        }
      }

      if (
        catalogItem.localConfigSecretId &&
        catalogItem.localConfig?.environment
      ) {
        const secret = secretMap.get(catalogItem.localConfigSecretId);
        if (secret) {
          for (const envVar of catalogItem.localConfig.environment) {
            const value = secret.secret[envVar.key];
            if (envVar.type === "secret" && value) {
              envVar.value = String(value);
            }
          }
        }
      }

      // Preset secret values
      if (catalogItem.presetSecretId) {
        const secret = secretMap.get(catalogItem.presetSecretId);
        if (secret) {
          catalogItem.presetFieldValues = {
            ...catalogItem.presetFieldValues,
            ...(secret.secret as Record<string, UserConfigFieldDefault>),
          };
        }
      }
    }
  }

  /**
   * Bulk-load list metadata for an array of DB rows and attach it.
   */
  private static async attachListMetadata(
    dbItems: Array<typeof schema.internalMcpCatalogTable.$inferSelect>,
  ): Promise<ListInternalMcpCatalog[]> {
    if (dbItems.length === 0) {
      return [];
    }

    const ids = dbItems.map((item) => item.id);
    const [labelsMap, teamsMap, toolCountMap] = await Promise.all([
      McpCatalogLabelModel.getLabelsForCatalogItems(ids),
      McpCatalogTeamModel.getTeamDetailsForCatalogs(ids),
      InternalMcpCatalogModel.getToolCounts(ids),
    ]);

    return dbItems.map((item) => ({
      ...item,
      labels: labelsMap.get(item.id) || [],
      teams: teamsMap.get(item.id) || [],
      toolCount: toolCountMap.get(item.id) ?? 0,
    }));
  }

  private static async getToolCounts(
    catalogIds: string[],
  ): Promise<Map<string, number>> {
    if (catalogIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        catalogId: schema.toolsTable.catalogId,
        toolCount: count(schema.toolsTable.id),
      })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.catalogId, catalogIds))
      .groupBy(schema.toolsTable.catalogId);

    return new Map(
      rows
        .filter(
          (row): row is { catalogId: string; toolCount: number } =>
            row.catalogId !== null,
        )
        .map((row) => [row.catalogId, row.toolCount]),
    );
  }

  /**
   * Populate authorName for catalog items that have an authorId.
   */
  private static async populateAuthorNames(
    catalogItems: InternalMcpCatalog[],
  ): Promise<void> {
    const authorIds = new Set<string>();
    for (const item of catalogItems) {
      if (item.authorId) authorIds.add(item.authorId);
    }

    if (authorIds.size === 0) return;

    const users = await db
      .select({ id: schema.usersTable.id, name: schema.usersTable.name })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, Array.from(authorIds)));

    const nameMap = new Map(users.map((u) => [u.id, u.name]));

    for (const item of catalogItems) {
      item.authorName = item.authorId
        ? (nameMap.get(item.authorId) ?? null)
        : null;
    }
  }

  // Org-or-global scoped audit snapshot. Returns data only for catalog rows
  // that belong to the requesting organization OR are global entries
  // (organizationId IS NULL, e.g. the seeded Archestra catalog). Returns null
  // for rows owned by a different org, preventing the snapshot-before-authz
  // cross-tenant leak: this fetcher runs in the audit preHandler before the
  // route handler has a chance to reject the request.
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        and(
          eq(schema.internalMcpCatalogTable.id, id),
          or(
            eq(schema.internalMcpCatalogTable.organizationId, organizationId),
            isNull(schema.internalMcpCatalogTable.organizationId),
          ),
        ),
      )
      .limit(1);

    if (!row) return null;

    const toolCount =
      (await InternalMcpCatalogModel.getToolCounts([id])).get(id) ?? 0;

    const transportType = row.localConfig?.transportType ?? "stdio";
    const envKeys = Array.isArray(row.localConfig?.environment)
      ? row.localConfig.environment.map((e) => e.key).sort()
      : [];
    const userConfigKeys = row.userConfig
      ? Object.keys(row.userConfig).sort()
      : [];
    const authFieldKeys = Array.isArray(row.authFields)
      ? row.authFields.map((f) => f.name).sort()
      : [];

    return {
      id: row.id,
      name: row.name,
      version: row.version ?? null,
      description: row.description ?? null,
      serverType: row.serverType,
      scope: row.scope,
      organizationId: row.organizationId ?? null,
      authorId: row.authorId,
      multitenant: row.multitenant,
      serverUrl: row.serverUrl ?? null,
      docsUrl: row.docsUrl ?? null,
      requiresAuth: row.requiresAuth,
      transportType,
      envKeys,
      userConfigKeys,
      authFieldKeys,
      hasOauthConfig: row.oauthConfig !== null,
      hasClientSecret: Boolean(row.clientSecretId),
      hasLocalConfigSecret: Boolean(row.localConfigSecretId),
      hasDeploymentSpecYaml: Boolean(row.deploymentSpecYaml),
      hasEnterpriseManagedConfig: row.enterpriseManagedConfig !== null,
      toolCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export default InternalMcpCatalogModel;
