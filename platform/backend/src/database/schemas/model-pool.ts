import {
  integer,
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
    /**
     * Seconds a member may take to send a stream's first chunk before the
     * request moves on (LiteLLM's `stream_timeout`). Null keeps the default.
     */
    streamTimeoutSeconds: integer("stream_timeout_seconds"),
    /**
     * Seconds a member may take to return a whole non-streamed answer
     * (LiteLLM's `timeout`). Null scales the default with the request's
     * output limit.
     */
    timeoutSeconds: integer("timeout_seconds"),
    /**
     * Shortest time in seconds a failed member is skipped; a longer
     * Retry-After extends it up to 60 s or this, whichever is longer
     * (LiteLLM's `cooldown_time`). Null keeps the default.
     */
    cooldownSeconds: integer("cooldown_seconds"),
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
