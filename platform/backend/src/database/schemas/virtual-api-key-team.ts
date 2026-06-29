import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { team } from "./team";
import virtualApiKeysTable from "./virtual-api-key";

const virtualApiKeyTeamsTable = pgTable(
  "virtual_api_key_team",
  {
    virtualApiKeyId: uuid("virtual_api_key_id")
      .notNull()
      .references(() => virtualApiKeysTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.virtualApiKeyId, table.teamId] }),
    teamIdIdx: index("idx_virtual_api_key_team_team_id").on(table.teamId),
  }),
);

export default virtualApiKeyTeamsTable;
