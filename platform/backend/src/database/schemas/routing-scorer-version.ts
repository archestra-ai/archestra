import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { RoutingScorerSpec } from "@/types/auto-routing";

/** Immutable scorer versions, one per distinct canonical spec. */
const routingScorerVersionsTable = pgTable("routing_scorer_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  model: text("model").notNull(),
  spec: jsonb("spec").$type<RoutingScorerSpec>().notNull(),
  /** sha256 of the canonical spec JSON. */
  specHash: text("spec_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export default routingScorerVersionsTable;
