import {
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const mcpCatalogTable = pgTable("mcp_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  repository: text("repository"),
  installationCommand: text("installation_command"),
  requiresAuth: boolean("requires_auth").notNull().default(false),
  authDescription: text("auth_description"),
  authFields: jsonb("auth_fields")
    .$type<
      Array<{
        name: string;
        label: string;
        type: string;
        required: boolean;
        description?: string;
      }>
    >()
    .default([]),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default mcpCatalogTable;
