import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import secretTable from "./secret";

// org-scoped GitHub App credentials shared by skill imports and knowledge connectors.
// the private key PEM lives only in the referenced secret row, never here.
const githubAppConfigsTable = pgTable(
  "github_app_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    githubUrl: text("github_url").notNull().default("https://api.github.com"),
    appId: text("app_id").notNull(),
    installationId: text("installation_id").notNull(),
    secretId: uuid("secret_id").references(() => secretTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("github_app_configs_organization_id_idx").on(table.organizationId),
  ],
);

export default githubAppConfigsTable;
