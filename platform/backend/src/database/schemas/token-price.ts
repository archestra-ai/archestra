import type { SupportedProvider } from "@shared";
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const tokenPriceTable = pgTable(
  "token_price",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").$type<SupportedProvider>().notNull(),
    model: varchar("model", { length: 255 }).notNull().unique(),
    pricePerMillionInput: numeric("price_per_million_input", {
      precision: 10,
      scale: 2,
    }).notNull(),
    pricePerMillionOutput: numeric("price_per_million_output", {
      precision: 10,
      scale: 2,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    modelIdx: index("token_price_model_idx").on(table.model),
  }),
);

export default tokenPriceTable;
