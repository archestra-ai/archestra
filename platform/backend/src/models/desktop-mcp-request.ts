import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import type { DesktopMcpJsonRpcMessage, DesktopMcpRequest } from "@/types";

class DesktopMcpRequestModel {
  static async create(params: {
    deviceId: string;
    channel: string;
    payload: DesktopMcpJsonRpcMessage;
    expiresAt: Date;
  }): Promise<DesktopMcpRequest> {
    const [request] = await db
      .insert(schema.desktopMcpRequestsTable)
      .values(params)
      .returning();
    return request;
  }

  /**
   * Hands the oldest pending messages of a device to one poll. Rows another
   * poll is taking at the same moment are skipped, so a message goes to one
   * poll only, whichever backend copy serves it.
   */
  static async claimPending(params: {
    deviceId: string;
    limit: number;
  }): Promise<DesktopMcpRequest[]> {
    const table = schema.desktopMcpRequestsTable;
    const claimable = db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.deviceId, params.deviceId),
          eq(table.status, "pending"),
          gt(table.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(table.createdAt))
      .limit(params.limit)
      .for("update", { skipLocked: true });
    const claimed = await db
      .update(table)
      .set({ status: "dispatched" })
      .where(inArray(table.id, claimable))
      .returning();
    return claimed.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  /**
   * Stores the MCP response of a dispatched message. Returns false when the
   * message is not waiting for one: unknown, of another device, already
   * answered, or removed after its deadline.
   */
  static async complete(params: {
    id: string;
    deviceId: string;
    response: DesktopMcpJsonRpcMessage | null;
  }): Promise<boolean> {
    const table = schema.desktopMcpRequestsTable;
    const completed = await db
      .update(table)
      .set({
        status: "completed",
        response: params.response,
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.deviceId, params.deviceId),
          eq(table.status, "dispatched"),
        ),
      )
      .returning({ id: table.id });
    return completed.length > 0;
  }

  /**
   * Removes a dispatched message that needs no stored answer (a notification
   * the tunnel client acknowledged). Returns false when it was not dispatched.
   */
  static async deleteDispatched(params: {
    id: string;
    deviceId: string;
  }): Promise<boolean> {
    const table = schema.desktopMcpRequestsTable;
    const deleted = await db
      .delete(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.deviceId, params.deviceId),
          eq(table.status, "dispatched"),
        ),
      )
      .returning({ id: table.id });
    return deleted.length > 0;
  }

  static async findById(id: string): Promise<DesktopMcpRequest | null> {
    const [request] = await db
      .select()
      .from(schema.desktopMcpRequestsTable)
      .where(eq(schema.desktopMcpRequestsTable.id, id))
      .limit(1);
    return request ?? null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.desktopMcpRequestsTable)
      .where(eq(schema.desktopMcpRequestsTable.id, id));
  }

  /** Removes messages whose caller stopped waiting without cleaning up. */
  static async deleteExpired(deviceId: string): Promise<void> {
    const table = schema.desktopMcpRequestsTable;
    await db
      .delete(table)
      .where(
        and(eq(table.deviceId, deviceId), lt(table.expiresAt, new Date())),
      );
  }
}

export default DesktopMcpRequestModel;
