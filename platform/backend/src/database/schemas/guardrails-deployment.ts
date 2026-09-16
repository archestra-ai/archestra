import { boolean, pgTable, text } from "drizzle-orm/pg-core";

// One row for the deployment; deliberately not owned by an organization.
const guardrailsDeploymentTable = pgTable("guardrails_deployment", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
});
export default guardrailsDeploymentTable;
