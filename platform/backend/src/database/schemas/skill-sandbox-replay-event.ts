import {
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
import skillSandboxUploadsTable from "./skill-sandbox-upload";

/**
 * Ordered replay log for a sandbox. Each event is either a command execution or
 * a file upload; replaying events in `sequence` order reproduces the exact
 * filesystem + command history. This interleaving is what makes an upload
 * between command A and command B invisible during A's replay — a plain command
 * log could not express that ordering.
 *
 * Exactly one of `commandId` / `uploadId` is set per row, keyed by `kind`.
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
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_replay_events_sandbox_id_idx").on(table.sandboxId),
    uniqueIndex("skill_sandbox_replay_events_sandbox_sequence_uidx").on(
      table.sandboxId,
      table.sequence,
    ),
  ],
);

export default skillSandboxReplayEventsTable;
