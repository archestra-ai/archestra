import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

/**
 * Auto-routing normal tiers the org-trio migration could not move into the
 * organization's default model because Agent Runtime agents inherit it. The
 * backend checks those agents against the tier once at startup and consumes
 * each row, a moved one once auto routing is re-enabled. The expected default is what the migration left in place: a tier
 * moves only over it, never over a later admin change.
 */
const orgTrioPendingNormalTierTable = pgTable("org_trio_pending_normal_tier", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  normalModelId: text("normal_model_id").notNull(),
  apiKeyId: text("api_key_id").notNull(),
  autoRoutingWasEnabled: boolean("auto_routing_was_enabled").notNull(),
  expectedDefaultModelId: text("expected_default_model_id"),
  expectedDefaultLlmApiKeyId: text("expected_default_llm_api_key_id"),
  /** The tier is the default now; only re-enabling auto routing remains. */
  moved: boolean("moved").notNull().default(false),
});

export default orgTrioPendingNormalTierTable;
