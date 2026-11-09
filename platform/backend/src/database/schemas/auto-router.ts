import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AutoRoutingBudgetPreset } from "@/types/auto-routing";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import organizationsTable from "./organization";
import routingScorerVersionsTable from "./routing-scorer-version";

/**
 * An auto router is a model name clients ask for (`auto`, `auto:support`)
 * that sends each session to one of its three tiers (`auto_routing_tiers`)
 * so that its average daily spend stays near its budget. An organization has
 * any number of them; each scores, plans and learns from its own sessions.
 * Plan-relevant columns are written under the routing-plan lock, which also
 * bumps `generation`.
 */
const autoRoutersTable = pgTable(
  "auto_routers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** The model name clients request: `auto`, or `auto:<name>`. */
    name: text("name").notNull(),
    budgetUsdPerDay: numeric("budget_usd_per_day", {
      precision: 12,
      scale: 2,
    }),
    /**
     * When set, each fit derives the daily budget from this preset and the
     * router's current usage instead of using `budgetUsdPerDay`, which stays
     * as the custom budget to return to.
     */
    budgetPreset: text("budget_preset").$type<AutoRoutingBudgetPreset>(),
    /**
     * The decision model that scores this router's sessions: a key of a
     * decisions provider and one of its models. A null key is the
     * organization's primary key of the default decisions provider.
     */
    scorerApiKeyId: uuid("scorer_api_key_id").references(
      () => llmProviderApiKeysTable.id,
      { onDelete: "set null" },
    ),
    scorerModel: text("scorer_model").notNull(),
    scorerVersionId: uuid("scorer_version_id").references(
      () => routingScorerVersionsTable.id,
    ),
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    plannedGeneration: bigint("planned_generation", { mode: "number" })
      .notNull()
      .default(0),
    /**
     * The router also learns from the organization's scored past sessions
     * (`routing_backfills`). Only the router that existed before an
     * organization could have several does; new ones start cold.
     */
    usesPastSessions: boolean("uses_past_sessions").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One router per name, so a request never has to choose between routers.
    uniqueIndex("auto_routers_org_name_uidx").on(
      table.organizationId,
      table.name,
    ),
    uniqueIndex("auto_routers_one_past_sessions_per_org_uidx")
      .on(table.organizationId)
      .where(sql`${table.usesPastSessions}`),
  ],
);

export default autoRoutersTable;
