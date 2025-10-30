import {
  decimal,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const tokenPricingTable = pgTable(
  "token_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 50 }).notNull(),
    model: varchar("model", { length: 200 }).notNull(),
    inputPricePer1M: decimal("input_price_per_1m", { precision: 10, scale: 2 })
      .notNull()
      .default("50.00"),
    outputPricePer1M: decimal("output_price_per_1m", {
      precision: 10,
      scale: 2,
    })
      .notNull()
      .default("50.00"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    providerModelUnique: unique("provider_model_unique").on(
      table.provider,
      table.model,
    ),
  }),
);

export default tokenPricingTable;
