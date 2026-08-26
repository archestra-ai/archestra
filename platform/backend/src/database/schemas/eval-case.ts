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
 * Eval cases: one or more ordered user messages sent to the agent in a single
 * conversation, plus the assertions the final answer must satisfy. Belongs to
 * a suite; ordered within the suite by `position`.
 */
const evalCasesTable = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => evalSuitesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Ordered user messages sent within one conversation; the agent answers
     * each in turn and assertions grade the final answer (tool assertions see
     * the whole conversation).
     */
    messages: jsonb("messages").$type<string[]>().notNull(),
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
