ALTER TABLE "identity_provider" DROP CONSTRAINT "identity_provider_provider_id_unique";--> statement-breakpoint
ALTER TABLE "label_keys" DROP CONSTRAINT "label_keys_key_unique";--> statement-breakpoint
ALTER TABLE "label_values" DROP CONSTRAINT "label_values_value_unique";--> statement-breakpoint
ALTER TABLE "models" DROP CONSTRAINT "models_provider_model_unique";--> statement-breakpoint
ALTER TABLE "organization_role" DROP CONSTRAINT "organization_role_organization_id_role_unique";--> statement-breakpoint
ALTER TABLE "team_external_group" DROP CONSTRAINT "team_external_group_team_group_unique";--> statement-breakpoint
ALTER TABLE "team_token" DROP CONSTRAINT "team_token_organization_id_team_id_unique";--> statement-breakpoint
ALTER TABLE "team_vault_folder" DROP CONSTRAINT "team_vault_folder_team_id_unique";--> statement-breakpoint
ALTER TABLE "tools" DROP CONSTRAINT "tools_catalog_id_name_agent_id_delegate_to_agent_id_unique";--> statement-breakpoint
ALTER TABLE "user_token" DROP CONSTRAINT "user_token_organization_id_user_id_unique";--> statement-breakpoint
DROP INDEX "agents_slug_idx";--> statement-breakpoint
DROP INDEX "agents_personal_gateway_per_member_idx";--> statement-breakpoint
DROP INDEX "chatops_channel_binding_provider_channel_workspace_idx";--> statement-breakpoint
DROP INDEX "kb_documents_source_idx";--> statement-breakpoint
DROP INDEX "kb_uploaded_files_content_hash_uidx";--> statement-breakpoint
DROP INDEX "chat_api_keys_system_unique";--> statement-breakpoint
DROP INDEX "chat_api_keys_primary_personal_unique";--> statement-breakpoint
DROP INDEX "chat_api_keys_primary_team_unique";--> statement-breakpoint
DROP INDEX "chat_api_keys_primary_org_unique";--> statement-breakpoint
ALTER TABLE "a2a_context" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_message" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "chatops_channel_binding" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "identity_provider" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "incoming_email_subscription" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "kb_uploaded_files" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "label_keys" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "label_values" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "mcp_server_installation_request" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "optimization_rules" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization_role" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team_token" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team_vault_folder" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "tool_invocation_policies" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "trusted_data_policies" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_token" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_provider_provider_id_uidx" ON "identity_provider" USING btree ("provider_id") WHERE "identity_provider"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "label_keys_key_uidx" ON "label_keys" USING btree ("key") WHERE "label_keys"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "label_values_value_uidx" ON "label_values" USING btree ("value") WHERE "label_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "models_provider_model_unique" ON "models" USING btree ("provider","model_id") WHERE "models"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_role_org_role_uidx" ON "organization_role" USING btree ("organization_id","role") WHERE "organization_role"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_external_group_team_group_unique" ON "team_external_group" USING btree ("team_id","group_identifier") WHERE "team_external_group"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_token_org_team_uidx" ON "team_token" USING btree ("organization_id","team_id") WHERE "team_token"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_vault_folder_team_id_uidx" ON "team_vault_folder" USING btree ("team_id") WHERE "team_vault_folder"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tools_identity_uidx" ON "tools" USING btree ("catalog_id","name","agent_id","delegate_to_agent_id") WHERE "tools"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_token_org_user_uidx" ON "user_token" USING btree ("organization_id","user_id") WHERE "user_token"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_slug_idx" ON "agents" USING btree ("slug") WHERE "agents"."slug" IS NOT NULL AND "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_personal_gateway_per_member_idx" ON "agents" USING btree ("organization_id","author_id") WHERE "agents"."agent_type" = 'mcp_gateway' AND "agents"."is_personal_gateway" = true AND "agents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_channel_binding_provider_channel_workspace_idx" ON "chatops_channel_binding" USING btree ("provider","channel_id","workspace_id") WHERE "chatops_channel_binding"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_source_idx" ON "kb_documents" USING btree ("connector_id","source_id") WHERE "kb_documents"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_uploaded_files_content_hash_uidx" ON "kb_uploaded_files" USING btree ("connector_id","content_hash") WHERE "kb_uploaded_files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_system_unique" ON "chat_api_keys" USING btree ("provider") WHERE "chat_api_keys"."is_system" = true AND "chat_api_keys"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_primary_personal_unique" ON "chat_api_keys" USING btree ("organization_id","provider","scope","user_id") WHERE "chat_api_keys"."is_primary" = true AND "chat_api_keys"."scope" = 'personal' AND "chat_api_keys"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_primary_team_unique" ON "chat_api_keys" USING btree ("organization_id","provider","scope","team_id") WHERE "chat_api_keys"."is_primary" = true AND "chat_api_keys"."scope" = 'team' AND "chat_api_keys"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_primary_org_unique" ON "chat_api_keys" USING btree ("organization_id","provider","scope") WHERE "chat_api_keys"."is_primary" = true AND "chat_api_keys"."scope" = 'org' AND "chat_api_keys"."deleted_at" IS NULL;