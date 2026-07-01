import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import skillSandboxesTable from "./skill-sandbox";

/**
 * Executed commands for a sandbox; rows are append-only. Replay order is NOT
 * this table's `createdAt` — it is `skill_sandbox_replay_events.sequence`,
 * which interleaves commands with uploads and skill mounts.
 */
const skillSandboxCommandsTable = pgTable(
  "skill_sandbox_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Denormalized owning org, copied from the parent sandbox at insert time. */
    organizationId: text("organization_id").notNull(),
    /** Shell command as it was passed to the runtime. */
    command: text("command").notNull(),
    /** Working directory used for this command; `null` means `defaultCwd`. */
    cwd: text("cwd"),
    stdout: text("stdout").notNull().default(""),
    stderr: text("stderr").notNull().default(""),
    /** Process exit code, or a synthetic value when the runtime aborted the run. */
    exitCode: integer("exit_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    /** Wall-clock timeout (seconds) used when this command was executed; replays use this value. */
    timeoutSeconds: integer("timeout_seconds").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_commands_sandbox_id_idx").on(table.sandboxId),
    index("skill_sandbox_commands_sandbox_created_idx").on(
      table.sandboxId,
      table.createdAt,
    ),
  ],
);

export default skillSandboxCommandsTable;
