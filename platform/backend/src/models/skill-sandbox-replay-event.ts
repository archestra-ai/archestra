import { asc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { SkillMountInput } from "@/skills-sandbox/types";
import type {
  InsertSkillSandboxCommand,
  InsertSkillSandboxUpload,
  SkillSandboxCommand,
  SkillSandboxFileSnapshot,
  SkillSandboxSkillMount,
  SkillSandboxUpload,
} from "@/types";
import { SkillInvalidFilePathError } from "./skill-sandbox";

/**
 * One materialized entry of a sandbox replay log, in execution order. The
 * runtime replays these to reconstruct sandbox state: commands re-execute,
 * uploads re-write their bytes, and skill mounts write their snapshotted files —
 * each at its recorded sequence point.
 */
export type SkillSandboxReplayEntry =
  | { kind: "command"; sequence: number; command: SkillSandboxCommand }
  | { kind: "upload"; sequence: number; upload: SkillSandboxUpload }
  | {
      kind: "skill_mount";
      sequence: number;
      mount: SkillSandboxSkillMount;
      files: SkillSandboxFileSnapshot[];
    };

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
   * Mount a skill into the sandbox: snapshot its files under a new
   * `skill_sandbox_skill_mounts` row and record it as the next ordered replay
   * event. Mounts are always appended at the current sequence — never inserted
   * mid-history — so prior command/upload layers keep their Dagger parent chain
   * and stay cache-hot. SKILL.md is stored at relative path "SKILL.md"; other
   * files keep their skill-relative path.
   *
   * When the skill ships an `installCommand` (its `uv pip install`), it is
   * appended as a `command` event in the SAME transaction right after the
   * mount, so a mount can never be recorded without its install (which would
   * leave the deps permanently missing once the idempotency check skips the
   * skill on re-activation).
   *
   * Throws {@link SkillInvalidFilePathError} if any file has an absolute or
   * traversal path.
   */
  static async appendSkillMount(params: {
    sandboxId: string;
    organizationId: string;
    skill: SkillMountInput;
    installCommand?: { command: string; cwd: string; timeoutSeconds: number };
  }): Promise<SkillSandboxSkillMount> {
    const { sandboxId, organizationId, skill, installCommand } = params;

    const snapshots: (typeof schema.skillSandboxFileSnapshotsTable.$inferInsert)[] =
      [];
    for (const file of skill.files) {
      if (
        file.path.startsWith("/") ||
        file.path.split("/").some((s) => s === "..") ||
        file.path === "SKILL.md"
      ) {
        throw new SkillInvalidFilePathError(skill.skillName, file.path);
      }
    }

    return await db.transaction(async (tx) => {
      const [mount] = await tx
        .insert(schema.skillSandboxSkillMountsTable)
        .values({
          sandboxId,
          organizationId,
          skillId: skill.skillId,
          skillName: skill.skillName,
        })
        .returning();
      if (!mount) {
        throw new Error("failed to insert skill mount");
      }

      snapshots.push({
        sandboxId,
        skillMountId: mount.id,
        organizationId,
        skillId: skill.skillId,
        skillName: skill.skillName,
        path: "SKILL.md",
        encoding: "utf8",
        content: skill.content,
      });
      for (const file of skill.files) {
        snapshots.push({
          sandboxId,
          skillMountId: mount.id,
          organizationId,
          skillId: skill.skillId,
          skillName: skill.skillName,
          path: file.path,
          encoding: file.encoding,
          content: file.content,
        });
      }
      await tx.insert(schema.skillSandboxFileSnapshotsTable).values(snapshots);

      const sequence = await allocateSequence(tx, sandboxId);
      await tx.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId,
        organizationId,
        sequence,
        kind: "skill_mount",
        skillMountId: mount.id,
      });

      if (installCommand) {
        const [commandRow] = await tx
          .insert(schema.skillSandboxCommandsTable)
          .values({
            sandboxId,
            organizationId,
            command: installCommand.command,
            cwd: installCommand.cwd,
            stdout: "",
            stderr: "",
            // placeholder result; replay re-executes the install.
            exitCode: 0,
            durationMs: 0,
            timeoutSeconds: installCommand.timeoutSeconds,
          })
          .returning();
        if (!commandRow) {
          throw new Error(
            "failed to insert skill requirements install command",
          );
        }
        const installSequence = await allocateSequence(tx, sandboxId);
        await tx.insert(schema.skillSandboxReplayEventsTable).values({
          sandboxId,
          organizationId,
          sequence: installSequence,
          kind: "command",
          commandId: commandRow.id,
        });
      }

      return mount;
    });
  }

  /**
   * Full replay log for a sandbox in execution order. Callers iterate this to
   * rebuild state into a freshly materialized container — commands re-run,
   * uploads re-write their bytes, and skill mounts write their files, each
   * interleaved at its sequence point.
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
        mount: schema.skillSandboxSkillMountsTable,
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
      .leftJoin(
        schema.skillSandboxSkillMountsTable,
        eq(
          schema.skillSandboxReplayEventsTable.skillMountId,
          schema.skillSandboxSkillMountsTable.id,
        ),
      )
      .where(eq(schema.skillSandboxReplayEventsTable.sandboxId, sandboxId))
      .orderBy(asc(schema.skillSandboxReplayEventsTable.sequence));

    // batch-load the file snapshots for every mount in one query, then group
    // by mount id so each skill_mount entry carries its full file set.
    const mountIds = rows
      .map((r) => r.mount?.id)
      .filter((id): id is string => id != null);
    const filesByMount = new Map<string, SkillSandboxFileSnapshot[]>();
    if (mountIds.length > 0) {
      const snapshotRows = await db
        .select()
        .from(schema.skillSandboxFileSnapshotsTable)
        .where(
          inArray(schema.skillSandboxFileSnapshotsTable.skillMountId, mountIds),
        )
        .orderBy(asc(schema.skillSandboxFileSnapshotsTable.path));
      for (const snap of snapshotRows) {
        const list = filesByMount.get(snap.skillMountId) ?? [];
        list.push(snap);
        filesByMount.set(snap.skillMountId, list);
      }
    }

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
        case "skill_mount":
          if (!row.mount) {
            throw new Error(
              `replay event ${row.sequence} for sandbox ${sandboxId} is a skill mount but has no mount row`,
            );
          }
          return {
            kind: "skill_mount",
            sequence: row.sequence,
            mount: row.mount,
            files: filesByMount.get(row.mount.id) ?? [],
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
