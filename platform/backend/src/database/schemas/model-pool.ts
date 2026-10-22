import type { SupportedProvider } from "@archestra/shared";
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A pool of provider keys that serve one model. A request for `modelId` on
 * `provider` whose resolved key is a member is balanced and failed over across
 * the pool's members (see `routes/proxy/model-pool-failover.ts`), so agents and
 * clients that pin one key keep working when that key is rate limited or down.
 */
const modelPoolsTable = pgTable(
  "model_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").$type<SupportedProvider>().notNull(),
    /** The model id clients request, as the proxy records it. */
    modelId: text("model_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One pool per model, so a request never has to choose between pools.
    uniqueIndex("model_pools_org_provider_model_unique").on(
      table.organizationId,
      table.provider,
      table.modelId,
    ),
  ],
);

export default modelPoolsTable;
