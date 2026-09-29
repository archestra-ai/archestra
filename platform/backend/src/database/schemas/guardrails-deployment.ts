import { boolean, pgTable, text, varchar } from "drizzle-orm/pg-core";
import type { UnsupportedAppaClientAction } from "@/types/guardrails-policy";

// One row for the deployment; deliberately not owned by an organization.
const guardrailsDeploymentTable = pgTable("guardrails_deployment", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  unsupportedClientAction: varchar("unsupported_client_action", { length: 16 })
    .$type<UnsupportedAppaClientAction>()
    .notNull()
    .default("bypass"),
});
export default guardrailsDeploymentTable;
