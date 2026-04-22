import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { LimitEntityType, LimitType } from "@/types";
import organizationsTable from "./organization";

const limitsTable = pgTable(
  "limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: varchar("entity_type").$type<LimitEntityType>().notNull(),
    entityId: text("entity_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    limitType: varchar("limit_type").$type<LimitType>().notNull(),
    limitValue: integer("limit_value").notNull(),
    mcpServerName: varchar("mcp_server_name", { length: 255 }),
    toolName: varchar("tool_name", { length: 255 }),
    // JSONB array stores multiple models for a single limit (e.g., ["gpt-4o", "claude-3-5-sonnet"])
    // This is the "source of truth" for which models a limit covers, enabling:
    // 1. Fast lookups: WHERE model ? 'gpt-4o' to find limits covering this model
    // 2. Initialization: Create limit_model_usage records for each model on limit creation
    // 3. Validation: Check if incoming interaction's model is within limit scope
    // The special sentinel ["*"] means the limit covers every model (see ALL_MODELS_SENTINEL).
    model: jsonb("model").$type<string[] | null>(),
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
    organizationIdx: index("limits_organization_id_idx").on(
      table.organizationId,
    ),
  }),
);

export default limitsTable;
