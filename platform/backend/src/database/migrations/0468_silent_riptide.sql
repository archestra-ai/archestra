ALTER TABLE "team" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_remote_agents" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_directories" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_files" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_credential_definitions" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "created_by_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "a2a_remote_agents" ADD CONSTRAINT "a2a_remote_agents_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "a2a_remote_agents" VALIDATE CONSTRAINT "a2a_remote_agents_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "apps" VALIDATE CONSTRAINT "apps_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" VALIDATE CONSTRAINT "internal_mcp_catalog_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "kb_directories" ADD CONSTRAINT "kb_directories_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kb_directories" VALIDATE CONSTRAINT "kb_directories_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "kb_files" ADD CONSTRAINT "kb_files_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kb_files" VALIDATE CONSTRAINT "kb_files_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD CONSTRAINT "knowledge_base_connectors_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" VALIDATE CONSTRAINT "knowledge_base_connectors_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "knowledge_bases" VALIDATE CONSTRAINT "knowledge_bases_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD CONSTRAINT "chat_api_keys_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_api_keys" VALIDATE CONSTRAINT "chat_api_keys_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "mcp_server" VALIDATE CONSTRAINT "mcp_server_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "plugins" VALIDATE CONSTRAINT "plugins_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "runtime_credential_definitions" ADD CONSTRAINT "runtime_credential_definitions_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "runtime_credential_definitions" VALIDATE CONSTRAINT "runtime_credential_definitions_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "service_accounts" VALIDATE CONSTRAINT "service_accounts_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skills" VALIDATE CONSTRAINT "skills_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "team" VALIDATE CONSTRAINT "team_created_by_service_account_id_service_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD CONSTRAINT "virtual_api_keys_created_by_service_account_id_service_accounts_id_fk" FOREIGN KEY ("created_by_service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" VALIDATE CONSTRAINT "virtual_api_keys_created_by_service_account_id_service_accounts_id_fk";