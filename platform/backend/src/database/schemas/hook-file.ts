import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { HookEvent } from "@/types/hook";
import agentsTable from "./agent";

const hookFilesTable = pgTable(
  "hook_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    event: text("event").$type<HookEvent>().notNull(),
    /** plain file name ending in .py or .sh */
    fileName: text("file_name").notNull(),
    content: text("content").notNull(),
    /** pip requirements for python hooks; run via `uv run --with`. empty for bash. */
    requirements: text("requirements").array().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("hook_files_agent_id_idx").on(table.agentId),
    uniqueIndex("hook_files_agent_event_file_uidx").on(
      table.agentId,
      table.event,
      table.fileName,
    ),
  ],
);
export default hookFilesTable;
