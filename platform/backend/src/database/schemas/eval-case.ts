import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { EvalAssertion } from "@/types/eval";
import evalSuitesTable from "./eval-suite";

/**
 * Eval cases: a single-turn input prompt plus the assertions its output must
 * satisfy. Belongs to a suite; ordered within the suite by `position`.
 */
const evalCasesTable = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => evalSuitesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The user message sent to the agent for this case. */
    input: text("input").notNull(),
    /** Typed assertion list (validated ≥1 at the API layer); all must pass. */
    assertions: jsonb("assertions").$type<EvalAssertion[]>().notNull(),
    /** Order within the suite; appended at max+1 on create. */
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("eval_cases_suite_id_position_idx").on(table.suiteId, table.position),
  ],
);

export default evalCasesTable;
