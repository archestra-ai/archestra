import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const a2aContextTable = pgTable(
  "a2a_context",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_context_actor_kind_id_idx").on(table.actorKind, table.actorId),
    index("a2a_context_updated_at_idx").on(table.updatedAt),
  ],
);

export default a2aContextTable;
