import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A pool is a model name that clients ask for, served by members that may sit
 * on any provider (see `model_pool_members`). A request for `name` is balanced
 * and failed over across the pool's members (see
 * `routes/proxy/model-pool-failover.ts`), so a client keeps working when one
 * provider key is rate limited or down.
 */
const modelPoolsTable = pgTable(
  "model_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** The model name clients request, e.g. `glm-5` or `claude-opus-4-8`. */
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One pool per name, so a request never has to choose between pools.
    uniqueIndex("model_pools_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export default modelPoolsTable;
