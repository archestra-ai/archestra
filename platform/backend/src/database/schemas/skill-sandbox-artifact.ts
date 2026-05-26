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
 * Files exported out of a sandbox via `get_skill_sandbox_artifact`. The raw
 * bytes are stored inline as `bytea` — there is no external object store in
 * v1. Sandboxes are ephemeral, so artifacts are how generated files survive a
 * Dagger cache flush.
 */
const skillSandboxArtifactsTable = pgTable(
  "skill_sandbox_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sandboxId: uuid("sandbox_id")
      .notNull()
      .references(() => skillSandboxesTable.id, { onDelete: "cascade" }),
    /** Path inside the sandbox the file was exported from. */
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandbox_artifacts_sandbox_id_idx").on(table.sandboxId),
  ],
);

export default skillSandboxArtifactsTable;
