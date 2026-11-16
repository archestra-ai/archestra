import { asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Site, SiteCapabilities, SiteRole } from "@/types";

/** The `sites` registry; see `sites/README.md`. */
class SiteModel {
  /** Write this site's row on startup, or refresh it after a restart. */
  static async upsert(params: {
    name: string;
    role: SiteRole;
    internalUrl: string | null;
    version: string;
    capabilities: SiteCapabilities;
  }): Promise<Site> {
    const now = new Date();
    const [row] = await db
      .insert(schema.sitesTable)
      .values({ ...params, startedAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: schema.sitesTable.name,
        // `draining` is an admin's call and survives restarts.
        set: { ...params, startedAt: now, lastSeenAt: now },
      })
      .returning();
    return row;
  }

  /** Mark a site alive. Returns false when its row was deleted. */
  static async heartbeat(name: string): Promise<boolean> {
    const rows = await db
      .update(schema.sitesTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.sitesTable.name, name))
      .returning({ name: schema.sitesTable.name });
    return rows.length > 0;
  }

  static async findByName(name: string): Promise<Site | null> {
    const [row] = await db
      .select()
      .from(schema.sitesTable)
      .where(eq(schema.sitesTable.name, name))
      .limit(1);
    return row ?? null;
  }

  static async findAll(): Promise<Site[]> {
    return db
      .select()
      .from(schema.sitesTable)
      .orderBy(asc(schema.sitesTable.name));
  }

  static async setDraining(
    name: string,
    draining: boolean,
  ): Promise<Site | null> {
    const [row] = await db
      .update(schema.sitesTable)
      .set({ draining })
      .where(eq(schema.sitesTable.name, name))
      .returning();
    return row ?? null;
  }

  static async delete(name: string): Promise<boolean> {
    const rows = await db
      .delete(schema.sitesTable)
      .where(eq(schema.sitesTable.name, name))
      .returning({ name: schema.sitesTable.name });
    return rows.length > 0;
  }
}

export default SiteModel;
