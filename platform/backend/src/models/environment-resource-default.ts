import {
  ENVIRONMENT_DEFAULTABLE_RESOURCES,
  type EnvironmentDefaultableResource,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { EnvironmentResourceDefaults } from "@/types";

// === Public API ===

class EnvironmentResourceDefaultModel {
  /**
   * The org's configured landing environment per resource kind. Kinds with no
   * row read back as `null` — the implicit Default environment — so callers get
   * a complete map and never have to special-case a missing key.
   */
  static async getForOrganization(
    organizationId: string,
  ): Promise<EnvironmentResourceDefaults> {
    const rows = await db
      .select({
        resource: schema.environmentResourceDefaultsTable.resource,
        environmentId: schema.environmentResourceDefaultsTable.environmentId,
      })
      .from(schema.environmentResourceDefaultsTable)
      .where(
        eq(
          schema.environmentResourceDefaultsTable.organizationId,
          organizationId,
        ),
      );

    const defaults = emptyDefaults();
    for (const row of rows) {
      // A row whose resource is no longer defaultable (kind removed from the
      // list) is ignored rather than widening the returned map.
      if (row.resource in defaults) defaults[row.resource] = row.environmentId;
    }
    return defaults;
  }

  /**
   * The configured environment id for one resource kind, or null when the kind
   * falls back to the Default environment.
   */
  static async findForResource(params: {
    organizationId: string;
    resource: EnvironmentDefaultableResource;
  }): Promise<string | null> {
    const [row] = await db
      .select({
        environmentId: schema.environmentResourceDefaultsTable.environmentId,
      })
      .from(schema.environmentResourceDefaultsTable)
      .where(
        and(
          eq(
            schema.environmentResourceDefaultsTable.organizationId,
            params.organizationId,
          ),
          eq(schema.environmentResourceDefaultsTable.resource, params.resource),
        ),
      )
      .limit(1);
    return row?.environmentId ?? null;
  }

  /**
   * Point a resource kind at an environment, or (with a null environmentId)
   * reset it to the Default environment by dropping the row.
   */
  static async setForResource(params: {
    organizationId: string;
    resource: EnvironmentDefaultableResource;
    environmentId: string | null;
  }): Promise<void> {
    const { organizationId, resource, environmentId } = params;
    if (environmentId === null) {
      await db
        .delete(schema.environmentResourceDefaultsTable)
        .where(
          and(
            eq(
              schema.environmentResourceDefaultsTable.organizationId,
              organizationId,
            ),
            eq(schema.environmentResourceDefaultsTable.resource, resource),
          ),
        );
      return;
    }

    await db
      .insert(schema.environmentResourceDefaultsTable)
      .values({ organizationId, resource, environmentId })
      .onConflictDoUpdate({
        target: [
          schema.environmentResourceDefaultsTable.organizationId,
          schema.environmentResourceDefaultsTable.resource,
        ],
        set: { environmentId, updatedAt: new Date() },
      });
  }

  /** Audit snapshot: the whole per-resource map, keyed by organization. */
  static async findByIdForAudit(
    _id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return EnvironmentResourceDefaultModel.getForOrganization(organizationId);
  }
}

export default EnvironmentResourceDefaultModel;

// === Internal helpers ===

function emptyDefaults(): EnvironmentResourceDefaults {
  return Object.fromEntries(
    ENVIRONMENT_DEFAULTABLE_RESOURCES.map((resource) => [resource, null]),
  ) as EnvironmentResourceDefaults;
}
