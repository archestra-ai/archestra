import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import modelsTable from "./model";
import { team } from "./team";

/**
 * Restricts an LLM model to specific teams. A model with no rows here is
 * available to everyone (the default); once at least one row exists, only
 * members of the listed teams (and model-catalog admins) can see the model in
 * pickers/listings or invoke it through the LLM proxy.
 */
const modelTeamsTable = pgTable(
  "model_team",
  {
    modelId: uuid("model_id")
      .notNull()
      .references(() => modelsTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.modelId, table.teamId] }),
  }),
);

export default modelTeamsTable;
