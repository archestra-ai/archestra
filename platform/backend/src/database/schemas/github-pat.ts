import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import secretTable from "./secret";

// org-scoped stored GitHub personal access tokens, managed at /settings/github
// alongside GitHub App configs. The token value lives only in the referenced
// secret row ({ apiToken }), never here. Used to authenticate skill imports
// and recurring skill sync.
const githubPatsTable = pgTable(
  "github_pats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
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
    index("github_pats_organization_id_idx").on(table.organizationId),
  ],
);

export default githubPatsTable;
