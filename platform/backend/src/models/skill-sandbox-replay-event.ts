import { asc, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSkillSandboxCommand,
  InsertSkillSandboxUpload,
  SkillSandboxCommand,
  SkillSandboxUpload,
} from "@/types";

/**
 * One materialized entry of a sandbox replay log, in execution order. The
 * runtime replays these to reconstruct sandbox state: commands re-execute,
 * uploads re-write their bytes at the recorded sequence point.
 */
export type SkillSandboxReplayEntry =
  | { kind: "command"; sequence: number; command: SkillSandboxCommand }
  | { kind: "upload"; sequence: number; upload: SkillSandboxUpload };

/**
 * Owns the ordered replay log (`skill_sandbox_replay_events`) and the two
 * payload tables it points at (commands, uploads). Appends allocate a per-
 * sandbox sequence atomically from `skill_sandboxes.next_replay_sequence` and
 * insert the payload + event in one transaction, so the on-disk order always
 * matches the order operations were accepted.
 */
class SkillSandboxReplayEventModel {
  /** Insert a command and record it as the next ordered replay event. */
  static async appendCommand(
    command: InsertSkillSandboxCommand,
  ): Promise<SkillSandboxCommand> {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.skillSandboxCommandsTable)
        .values(command)
        .returning();
      if (!row) {
        throw new Error("failed to insert sandbox command");
      }
      const sequence = await allocateSequence(tx, command.sandboxId);
      await tx.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId: command.sandboxId,
        organizationId: command.organizationId,
        sequence,
        kind: "command",
        commandId: row.id,
      });
      return row;
    });
  }

  /** Insert an uploaded file and record it as the next ordered replay event. */
  static async appendUpload(
    upload: InsertSkillSandboxUpload,
  ): Promise<SkillSandboxUpload> {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.skillSandboxUploadsTable)
        .values(upload)
        .returning();
      if (!row) {
        throw new Error("failed to insert sandbox upload");
      }
      const sequence = await allocateSequence(tx, upload.sandboxId);
      await tx.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId: upload.sandboxId,
        organizationId: upload.organizationId,
        sequence,
        kind: "upload",
        uploadId: row.id,
      });
      return normalizeUploadData(row);
    });
  }

  /**
   * Full replay log for a sandbox in execution order. Callers iterate this to
   * rebuild state into a freshly materialized container — commands re-run,
   * uploads re-write their bytes interleaved at their sequence point.
   */
  static async listBySandbox(
    sandboxId: string,
  ): Promise<SkillSandboxReplayEntry[]> {
    const rows = await db
      .select({
        kind: schema.skillSandboxReplayEventsTable.kind,
        sequence: schema.skillSandboxReplayEventsTable.sequence,
        command: schema.skillSandboxCommandsTable,
        upload: schema.skillSandboxUploadsTable,
      })
      .from(schema.skillSandboxReplayEventsTable)
      .leftJoin(
        schema.skillSandboxCommandsTable,
        eq(
          schema.skillSandboxReplayEventsTable.commandId,
          schema.skillSandboxCommandsTable.id,
        ),
      )
      .leftJoin(
        schema.skillSandboxUploadsTable,
        eq(
          schema.skillSandboxReplayEventsTable.uploadId,
          schema.skillSandboxUploadsTable.id,
        ),
      )
      .where(eq(schema.skillSandboxReplayEventsTable.sandboxId, sandboxId))
      .orderBy(asc(schema.skillSandboxReplayEventsTable.sequence));

    return rows.map((row): SkillSandboxReplayEntry => {
      switch (row.kind) {
        case "command":
          if (!row.command) {
            throw new Error(
              `replay event ${row.sequence} for sandbox ${sandboxId} is a command but has no command row`,
            );
          }
          return {
            kind: "command",
            sequence: row.sequence,
            command: row.command,
          };
        case "upload":
          if (!row.upload) {
            throw new Error(
              `replay event ${row.sequence} for sandbox ${sandboxId} is an upload but has no upload row`,
            );
          }
          return {
            kind: "upload",
            sequence: row.sequence,
            upload: normalizeUploadData(row.upload),
          };
        default:
          throw new Error(
            `replay event ${row.sequence} for sandbox ${sandboxId} has an unknown kind ${JSON.stringify(row.kind)}`,
          );
      }
    });
  }
}

export default SkillSandboxReplayEventModel;

// === internal helpers ===

/**
 * Atomically reserve the next replay sequence for a sandbox and return it. The
 * `+ 1` happens in the same UPDATE that reads the value, so concurrent appends
 * can never receive the same sequence.
 */
async function allocateSequence(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sandboxId: string,
): Promise<number> {
  const [row] = await tx
    .update(schema.skillSandboxesTable)
    .set({
      nextReplaySequence: sql`${schema.skillSandboxesTable.nextReplaySequence} + 1`,
    })
    .where(eq(schema.skillSandboxesTable.id, sandboxId))
    .returning({ next: schema.skillSandboxesTable.nextReplaySequence });
  if (!row) {
    throw new Error(
      `sandbox ${sandboxId} does not exist while allocating a replay sequence`,
    );
  }
  return row.next - 1;
}

/**
 * pg returns `bytea` as Buffer; PGlite returns Uint8Array. Callers rely on
 * Buffer semantics (`.toString("base64")`), so normalize at the read boundary.
 */
function normalizeUploadData(row: SkillSandboxUpload): SkillSandboxUpload {
  if (Buffer.isBuffer(row.data)) return row;
  return { ...row, data: Buffer.from(row.data as unknown as Uint8Array) };
}
