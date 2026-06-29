import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertSkillSandboxCommand,
  SandboxFileOrigin,
  SkillSandboxCommand,
  SkillSandboxFile,
  SkillSandboxSkillMount,
  SkillVersionFile,
} from "@/types";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/** Bytes for an uploaded input file, written into the replay log. */
interface UploadInput {
  sandboxId: string;
  /** Sandbox owner — names the per-user storage folder. Not a column. */
  userId: string;
  path: string;
  mimeType: string;
  originalName: string | null;
  sizeBytes: number;
  data: Buffer;
  /**
   * Source chat attachment when this upload was auto-staged. When set, the
   * insert is idempotent per `(sandbox_id, source_attachment_id)` — a repeat
   * stage is a no-op that returns `null` instead of a duplicate replay event.
   */
  sourceAttachmentId?: string | null;
  /** How the upload entered the sandbox; 'my_file' = copied from the user's PFS. */
  origin?: SandboxFileOrigin | null;
}

/** Identity of the skill version a mount pins. */
interface SkillMountRef {
  skillId: string;
  skillName: string;
  skillVersionId: string;
}

/**
 * One materialized entry of a sandbox replay log, in execution order. The
 * runtime replays these to reconstruct sandbox state: commands re-execute,
 * uploads re-write their bytes, and skill mounts write the pinned version's
 * SKILL.md (`content`) plus its resource files (`files`) — each at its recorded
 * sequence point.
 */
type SkillSandboxReplayEntry =
  | { kind: "command"; sequence: number; command: SkillSandboxCommand }
  | { kind: "upload"; sequence: number; upload: SkillSandboxFile }
  | {
      kind: "skill_mount";
      sequence: number;
      mount: SkillSandboxSkillMount;
      /** SKILL.md body from the pinned `skill_versions` row. */
      content: string;
      files: SkillVersionFile[];
    };

/**
 * Owns the ordered replay log (`skill_sandbox_replay_events`) and the payload it
 * points at (commands, uploaded files, skill mounts). Appends allocate a per-
 * sandbox sequence atomically from `skill_sandboxes.next_replay_sequence` and
 * insert the payload + event in one transaction, so the on-disk order always
 * matches the order operations were accepted.
 */
class SkillSandboxReplayEventModel {
  /** Insert a command and record it as the next ordered replay event. */
  static async appendCommand(
    command: InsertSkillSandboxCommand,
  ): Promise<SkillSandboxCommand> {
    // A command that pipes binary to stdout (e.g. `curl <url> | head`,
    // `cat image.png`) embeds NUL bytes that a Postgres `text` column rejects
    // ("invalid byte sequence for encoding UTF8: 0x00"). Strip them from the
    // captured output so the insert never crashes — same as
    // InteractionModel.create. `command`/`cwd` are NOT stripped: they are the
    // inputs that get re-executed on replay, so they are rejected up front when
    // they contain NUL (see runtime service `validateCommand`) rather than
    // silently rewritten here.
    const sanitized: InsertSkillSandboxCommand = {
      ...command,
      stdout: stripNullBytes(command.stdout),
      stderr: stripNullBytes(command.stderr),
    };
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.skillSandboxCommandsTable)
        .values(sanitized)
        .returning();
      if (!row) {
        throw new Error("failed to insert sandbox command");
      }
      const sequence = await allocateSequence(tx, command.sandboxId);
      await tx.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId: command.sandboxId,
        sequence,
        kind: "command",
        commandId: row.id,
      });
      return row;
    });
  }

  /**
   * Insert an uploaded file and record it as the next ordered replay event.
   *
   * Returns `null` when `sourceAttachmentId` is set and an upload for that
   * (sandbox, attachment) already exists: the partial unique index makes the
   * insert a race-safe no-op, so concurrent auto-staging across processes never
   * doubles a staged attachment. Tool uploads (no `sourceAttachmentId`) never
   * conflict and always return a row.
   */
  static async appendUpload(
    upload: UploadInput,
  ): Promise<SkillSandboxFile | null> {
    // id is generated app-side (not by the column default) so the replay-event
    // row can reference it within the same transaction.
    const fileId = randomUUID();
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.skillSandboxFilesTable)
        .values({
          id: fileId,
          kind: "upload",
          sandboxId: upload.sandboxId,
          path: upload.path,
          mimeType: upload.mimeType,
          originalName: upload.originalName,
          sourceAttachmentId: upload.sourceAttachmentId ?? null,
          origin: upload.origin ?? null,
          sizeBytes: upload.sizeBytes,
          // uploads are always Postgres bytes; the column is NOT NULL again.
          data: upload.data,
        })
        .onConflictDoNothing({
          target: [
            schema.skillSandboxFilesTable.sandboxId,
            schema.skillSandboxFilesTable.sourceAttachmentId,
          ],
          where: sql`${schema.skillSandboxFilesTable.sourceAttachmentId} is not null`,
        })
        .returning();
      // already staged: ON CONFLICT made the insert a no-op.
      if (!inserted) return null;
      const sequence = await allocateSequence(tx, upload.sandboxId);
      await tx.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId: upload.sandboxId,
        sequence,
        kind: "upload",
        fileId: inserted.id,
      });
      return normalizeByteaField(inserted, "data");
    });
    return row;
  }

  /**
   * Mount a skill version into the sandbox: insert a
   * `skill_sandbox_skill_mounts` row pinning `skillVersionId` and record it as
   * the next ordered replay event. Mounts are always appended at the current
   * sequence — never inserted mid-history — so prior command/upload layers keep
   * their Dagger parent chain and stay cache-hot.
   *
   * Idempotent and race-safe: the insert uses
   * `ON CONFLICT (sandbox_id, skill_id) DO NOTHING`, so a concurrent or repeated
   * activation of the same skill is a no-op that returns `null` without
   * appending a second mount (or its install commands).
   *
   * When the version ships `requirements.txt` files, `installCommands` are
   * appended as `command` events in the SAME transaction right after the mount
   * (in the given order), so a mount can never be recorded without its installs
   * (which would leave the deps permanently missing once the idempotency check
   * skips the skill on re-activation).
   */
  static async appendSkillMount(params: {
    sandboxId: string;
    organizationId: string;
    mount: SkillMountRef;
    installCommands?: Array<{
      command: string;
      cwd: string;
      timeoutSeconds: number;
    }>;
  }): Promise<SkillSandboxSkillMount | null> {
    const { sandboxId, organizationId, mount, installCommands } = params;

    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.skillSandboxSkillMountsTable)
        .values({
          sandboxId,
          skillId: mount.skillId,
          skillVersionId: mount.skillVersionId,
          skillName: mount.skillName,
        })
        .onConflictDoNothing({
          target: [
            schema.skillSandboxSkillMountsTable.sandboxId,
            schema.skillSandboxSkillMountsTable.skillId,
          ],
        })
        .returning();
      // already mounted: leave the existing mount + its layers untouched.
      if (!row) return null;

      const sequence = await allocateSequence(tx, sandboxId);
      await tx.insert(schema.skillSandboxReplayEventsTable).values({
        sandboxId,
        sequence,
        kind: "skill_mount",
        skillMountId: row.id,
      });

      for (const installCommand of installCommands ?? []) {
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
          sequence: installSequence,
          kind: "command",
          commandId: commandRow.id,
        });
      }

      return row;
    });
  }

  /**
   * Full replay log for a sandbox in execution order. Callers iterate this to
   * rebuild state into a freshly materialized container — commands re-run,
   * uploads re-write their bytes, and skill mounts write the pinned version's
   * files, each interleaved at its sequence point.
   */
  static async listBySandbox(
    sandboxId: string,
  ): Promise<SkillSandboxReplayEntry[]> {
    const rows = await db
      .select({
        kind: schema.skillSandboxReplayEventsTable.kind,
        sequence: schema.skillSandboxReplayEventsTable.sequence,
        command: schema.skillSandboxCommandsTable,
        upload: schema.skillSandboxFilesTable,
        mount: schema.skillSandboxSkillMountsTable,
        versionContent: schema.skillVersionsTable.content,
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
        schema.skillSandboxFilesTable,
        eq(
          schema.skillSandboxReplayEventsTable.fileId,
          schema.skillSandboxFilesTable.id,
        ),
      )
      .leftJoin(
        schema.skillSandboxSkillMountsTable,
        eq(
          schema.skillSandboxReplayEventsTable.skillMountId,
          schema.skillSandboxSkillMountsTable.id,
        ),
      )
      .leftJoin(
        schema.skillVersionsTable,
        eq(
          schema.skillSandboxSkillMountsTable.skillVersionId,
          schema.skillVersionsTable.id,
        ),
      )
      .where(eq(schema.skillSandboxReplayEventsTable.sandboxId, sandboxId))
      .orderBy(asc(schema.skillSandboxReplayEventsTable.sequence));

    // batch-load the version files for every mounted version in one query, then
    // group by version id so each skill_mount entry carries its full file set.
    const versionIds = rows
      .map((r) => r.mount?.skillVersionId)
      .filter((id): id is string => id != null);
    const filesByVersion = new Map<string, SkillVersionFile[]>();
    if (versionIds.length > 0) {
      const fileRows = await db
        .select()
        .from(schema.skillVersionFilesTable)
        .where(inArray(schema.skillVersionFilesTable.versionId, versionIds))
        .orderBy(asc(schema.skillVersionFilesTable.path));
      for (const file of fileRows) {
        const list = filesByVersion.get(file.versionId) ?? [];
        list.push(file);
        filesByVersion.set(file.versionId, list);
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
              `replay event ${row.sequence} for sandbox ${sandboxId} is an upload but has no file row`,
            );
          }
          return {
            kind: "upload",
            sequence: row.sequence,
            upload: normalizeByteaField(row.upload, "data"),
          };
        case "skill_mount":
          if (!row.mount || row.versionContent == null) {
            throw new Error(
              `replay event ${row.sequence} for sandbox ${sandboxId} is a skill mount but has no mount/version row`,
            );
          }
          return {
            kind: "skill_mount",
            sequence: row.sequence,
            mount: row.mount,
            content: row.versionContent,
            files: filesByVersion.get(row.mount.skillVersionId) ?? [],
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

function stripNullBytes<T extends string | null | undefined>(value: T): T {
  return (
    typeof value === "string" ? value.replaceAll("\u0000", "") : value
  ) as T;
}
