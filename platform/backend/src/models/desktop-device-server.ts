import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { DesktopDeviceServer, DesktopMcpServerState } from "@/types";

class DesktopDeviceServerModel {
  static async findByDeviceId(
    deviceId: string,
  ): Promise<DesktopDeviceServer[]> {
    return db
      .select()
      .from(schema.desktopDeviceServersTable)
      .where(eq(schema.desktopDeviceServersTable.deviceId, deviceId));
  }

  /** Stores whether the user started or stopped one MCP server on a device. */
  static async saveEnabled(params: {
    deviceId: string;
    catalogId: string;
    enabled: boolean;
  }): Promise<DesktopDeviceServer> {
    const [row] = await db
      .insert(schema.desktopDeviceServersTable)
      .values({
        deviceId: params.deviceId,
        catalogId: params.catalogId,
        enabled: params.enabled,
      })
      .onConflictDoUpdate({
        target: [
          schema.desktopDeviceServersTable.deviceId,
          schema.desktopDeviceServersTable.catalogId,
        ],
        set: { enabled: params.enabled, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /**
   * Stores that one MCP server on a device is about to start again: its
   * config changed in Archestra, so the state the tunnel client reported is
   * of a server that the device stops when it gets the config. The next
   * report of the tunnel client stores the state again. Whether the user
   * stopped the MCP server stays as it is.
   */
  static async markStarting(params: {
    deviceId: string;
    catalogId: string;
  }): Promise<void> {
    await db
      .insert(schema.desktopDeviceServersTable)
      .values({
        deviceId: params.deviceId,
        catalogId: params.catalogId,
        state: "starting",
        lastError: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.desktopDeviceServersTable.deviceId,
          schema.desktopDeviceServersTable.catalogId,
        ],
        set: { state: "starting", lastError: null },
      });
  }

  /**
   * Stores the states the tunnel client reported. A state for a catalog item
   * that does not exist any more is dropped.
   */
  static async recordStates(params: {
    deviceId: string;
    states: Array<{
      catalogId: string;
      state: DesktopMcpServerState;
      lastError: string | null;
    }>;
  }): Promise<void> {
    if (params.states.length === 0) return;
    const existing = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(
        inArray(
          schema.internalMcpCatalogTable.id,
          params.states.map((state) => state.catalogId),
        ),
      );
    const existingIds = new Set(existing.map((item) => item.id));
    const rows = params.states
      .filter((state) => existingIds.has(state.catalogId))
      .map((state) => ({ deviceId: params.deviceId, ...state }));
    if (rows.length === 0) return;
    await db
      .insert(schema.desktopDeviceServersTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          schema.desktopDeviceServersTable.deviceId,
          schema.desktopDeviceServersTable.catalogId,
        ],
        set: {
          state: sql`excluded.state`,
          lastError: sql`excluded.last_error`,
        },
      });
  }
}

export default DesktopDeviceServerModel;
