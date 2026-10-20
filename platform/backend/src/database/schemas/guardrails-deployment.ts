import { boolean, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import type { UnsupportedAppaClientAction } from "@/types/guardrails-policy";
import llmProviderApiKeysTable from "./llm-provider-api-key";
import modelsTable from "./model";

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
  // Unread since policy snapshots were removed: every session follows its
  // organization's policy. The column stays until the next release drops it.
  newSessionPolicy: varchar("new_session_policy", { length: 16 })
    .notNull()
    .default("live"),
  // The model and key `builtin = "archestra"` annotators answer with, set
  // together. Both null: the organization's default model.
  annotatorModelId: uuid("annotator_model_id").references(
    () => modelsTable.id,
    {
      onDelete: "set null",
    },
  ),
  annotatorLlmApiKeyId: uuid("annotator_llm_api_key_id").references(
    () => llmProviderApiKeysTable.id,
    { onDelete: "set null" },
  ),
});
export default guardrailsDeploymentTable;
