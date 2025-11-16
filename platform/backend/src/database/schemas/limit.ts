import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { LimitEntityType, LimitType } from "@/types";

const limitsTable = pgTable(
  "limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: varchar("entity_type").$type<LimitEntityType>().notNull(),
    entityId: text("entity_id").notNull(),
    limitType: varchar("limit_type").$type<LimitType>().notNull(),
    limitValue: integer("limit_value").notNull(),
    currentUsageTokensIn: integer("current_usage_tokens_in")
      .notNull()
      .default(0),
    currentUsageTokensOut: integer("current_usage_tokens_out")
      .notNull()
      .default(0),
    mcpServerName: varchar("mcp_server_name", { length: 255 }),
    toolName: varchar("tool_name", { length: 255 }),
    model: varchar("model", { length: 255 }),
    lastCleanup: timestamp("last_cleanup", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    entityIdx: index("limits_entity_idx").on(table.entityType, table.entityId),
    limitTypeIdx: index("limits_type_idx").on(table.limitType),
  }),
);

export default limitsTable;
