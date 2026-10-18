import { boolean, pgTable, text, varchar } from "drizzle-orm/pg-core";
import type {
  NewSessionPolicy,
  UnsupportedAppaClientAction,
} from "@/types/guardrails-policy";

// One row for the deployment; deliberately not owned by an organization.
const guardrailsDeploymentTable = pgTable("guardrails_deployment", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  unsupportedClientAction: varchar("unsupported_client_action", { length: 16 })
    .$type<UnsupportedAppaClientAction>()
    .notNull()
    .default("bypass"),
  // Whether a yell also turns OpenAPPA off for the session that sends it.
  breakTheGlassEnabled: boolean("superyell_enabled").notNull().default(true),
  // `snapshot`: no policy revision is published, open sessions keep the
  // revision they have, and new ones keep the policy they open with.
  newSessionPolicy: varchar("new_session_policy", { length: 16 })
    .$type<NewSessionPolicy>()
    .notNull()
    .default("live"),
});
export default guardrailsDeploymentTable;
