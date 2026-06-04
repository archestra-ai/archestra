import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { SkillSandboxReplayEventKind } from "@/types/skill-sandbox";
import skillSandboxesTable from "./skill-sandbox";
import skillSandboxCommandsTable from "./skill-sandbox-command";
import skillSandboxSkillMountsTable from "./skill-sandbox-skill-mount";
import skillSandboxUploadsTable from "./skill-sandbox-upload";

/**
 * Ordered replay log for a sandbox. Each event is a command execution, a file
 * upload, or a skill mount; replaying events in `sequence` order reproduces the
 * exact filesystem + command history. This interleaving is what makes an upload
 * between command A and command B invisible during A's replay — a plain command
 * log could not express that ordering. Skill mounts are append-only: an
 * activation always lands at the current sequence, so prior command/upload
 * layers keep their parent chain and stay cache-hot.
 *
 * Exactly one of `commandId` / `uploadId` / `skillMountId` is set per row, keyed
 * by `kind` and enforced by a DB-level check constraint.
 */
const skillSandboxReplayEventsTable = pgTable(
  "skill_sandbox_replay_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Denormalized owning org, copied from the parent sandbox at insert time. */
    organizationId: text("organization_id").notNull(),
    /** Per-sandbox monotonic order, allocated from `skill_sandboxes.next_replay_sequence`. */
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<SkillSandboxReplayEventKind>().notNull(),
    commandId: uuid("command_id").references(
      () => skillSandboxCommandsTable.id,
      { onDelete: "cascade" },
    ),
    uploadId: uuid("upload_id").references(() => skillSandboxUploadsTable.id, {
      onDelete: "cascade",
    }),
    skillMountId: uuid("skill_mount_id").references(
      () => skillSandboxSkillMountsTable.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_replay_events_sandbox_id_idx").on(table.sandboxId),
    uniqueIndex("skill_sandbox_replay_events_sandbox_sequence_uidx").on(
      table.sandboxId,
      table.sequence,
    ),
    // exactly one payload fk is set — a malformed row would be a latent replay
    // failure, so reject it at write time rather than at materialize time.
    check(
      "skill_sandbox_replay_events_one_payload_chk",
      sql`(
        (${table.commandId} IS NOT NULL)::int
        + (${table.uploadId} IS NOT NULL)::int
        + (${table.skillMountId} IS NOT NULL)::int
      ) = 1`,
    ),
  ],
);

export default skillSandboxReplayEventsTable;
