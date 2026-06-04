import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import skillSandboxesTable from "./skill-sandbox";

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Files uploaded into a sandbox via `upload_file`. Unlike
 * artifacts (output bytes copied out of a materialized container), uploads are
 * inputs: their raw bytes become part of the sandbox replay recipe. Each upload
 * is referenced from exactly one ordered `skill_sandbox_replay_events` row, so a
 * file uploaded between two commands is materialized at that point — never
 * visible to a command that ran before it.
 */
const skillSandboxUploadsTable = pgTable(
  "skill_sandbox_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Denormalized owning org, copied from the parent sandbox at insert time. */
    organizationId: text("organization_id").notNull(),
    /** Absolute path the file is written to inside the container. */
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull(),
    /** Caller-provided source filename, when known. */
    originalName: text("original_name"),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_uploads_sandbox_id_idx").on(table.sandboxId),
  ],
);

export default skillSandboxUploadsTable;
