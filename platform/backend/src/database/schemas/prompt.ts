import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const promptTypeEnum = ["system", "regular"] as const;
export type PromptType = (typeof promptTypeEnum)[number];

const promptsTable = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  type: text("type").$type<PromptType>().notNull(),
  content: text("content").notNull(),
  version: integer("version").notNull().default(1),
  parentPromptId: uuid("parent_prompt_id"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default promptsTable;
