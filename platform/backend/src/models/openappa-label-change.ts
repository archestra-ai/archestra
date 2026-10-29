import { and, asc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { LabelChange } from "@/types/openappa-label-changes";

/**
 * The label changes OpenAPPA recorded (written by the native runtime after a
 * dispatch; read only for display).
 */
class OpenappaLabelChangeModel {
  /**
   * Every recorded label change of the session families an LLM session's
   * OpenAPPA sessions belong to, oldest first. `callerId` keeps a viewer to
   * the sessions they ran.
   */
  static async findByLlmSession(params: {
    organizationId: string;
    llmSessionId: string;
    callerId?: string;
  }): Promise<LabelChange[]> {
    const table = schema.openappaLabelChangesTable;
    const sessions = schema.openappaSessionsTable;
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          params.callerId ? eq(table.callerId, params.callerId) : undefined,
          // The LLM session id is the client's own session id, the part
          // after the caller scope in OpenAPPA's session id (indexed).
          inArray(
            table.root,
            db
              .select({ root: sessions.root })
              .from(sessions)
              .where(
                and(
                  eq(sessions.organizationId, params.organizationId),
                  sql`substr(${sessions.sessionId}, strpos(${sessions.sessionId}, '|') + 1) = ${params.llmSessionId}`,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(table.createdAt), asc(table.id));
  }
}

export default OpenappaLabelChangeModel;
