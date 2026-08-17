import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { BatchAnalysisColumn } from "@/types/batch-analysis";
import type { ResourceVisibilityScope } from "@/types/visibility";
import agentsTable from "./agent";

/**
 * A batch analysis is a saved definition: a set of columns to evaluate against a
 * set of rows. It holds no results — those live on runs and cells — so the same
 * analysis can be re-run as its row set grows.
 */
const batchAnalysesTable = pgTable(
  "batch_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    /**
     * Visibility/management scope: `personal` (creator only), `team` (members
     * of the assigned teams, see `batch_analysis_team`), or `org` (everyone).
     * Mirrors `skills.scope` and `agents.scope`.
     *
     * Defaults to `personal`: an analysis names an agent whose credential its
     * runs spend, and its cells quote source documents the creator could read,
     * so the safe default is the narrowest one.
     */
    scope: text("scope")
      .$type<ResourceVisibilityScope>()
      .notNull()
      .default("personal"),
    /**
     * The agent whose configuration the run borrows: its model selection and
     * credential today, and its tool set once columns can call tools. Naming an
     * agent rather than resolving a bare org default is what will let a column
     * target an MCP tool without inventing a second configuration surface.
     *
     * Cascades on delete, which in practice almost never fires — agents are
     * soft-deleted — but keeps the definition from outliving the configuration
     * it depends on.
     */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /**
     * Ordered column definitions (prompt + output format). Stored as JSONB
     * rather than a table because columns are always read and written whole,
     * and nothing joins against an individual column.
     */
    columns: jsonb("columns")
      .$type<BatchAnalysisColumn[]>()
      .notNull()
      .default([]),
    /**
     * The user whose access the runner borrows when resolving row sources. A run
     * can never read a source this user could not read directly.
     */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("batch_analyses_org_id_idx").on(table.organizationId),
    index("batch_analyses_scope_idx").on(table.scope),
  ],
);

export default batchAnalysesTable;
