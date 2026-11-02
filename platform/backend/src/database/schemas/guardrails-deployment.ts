import { boolean, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import type {
  HumanApprovalMode,
  UnapprovableBlockMode,
  UnsupportedAppaClientAction,
} from "@/types/guardrails-policy";
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
  // Whether a call waiting for human approval runs anyway, with a yell. By
  // default it does where no person is there to approve it.
  humanApprovalMode: varchar("human_approval_mode", { length: 16 })
    .$type<HumanApprovalMode>()
    .notNull()
    .default("unattended"),
  // Whether a call no remedy can lift runs anyway, with a yell.
  unapprovableBlockMode: varchar("unapprovable_block_mode", { length: 16 })
    .$type<UnapprovableBlockMode>()
    .notNull()
    .default("refuse"),
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
