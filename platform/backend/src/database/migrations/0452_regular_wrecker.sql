-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Coordinated breaking rename of a feature-flagged capability before external rollout; old application versions are not supported during this deployment.

ALTER TABLE "agent_execution_inputs" RENAME TO "agent_run_inputs";--> statement-breakpoint
ALTER TABLE "execution_credential_connections" RENAME TO "runtime_credential_connections";--> statement-breakpoint
ALTER TABLE "execution_credential_definitions" RENAME TO "runtime_credential_definitions";--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "background_execution" TO "runtime";--> statement-breakpoint
ALTER TABLE "agents" RENAME COLUMN "background_execution_secret_id" TO "runtime_secret_id";--> statement-breakpoint
ALTER TABLE "agent_runs" RENAME COLUMN "deployment_name" TO "workload_name";--> statement-breakpoint
-- `interactions` is write-hot and large. Keep both its column and index changes
-- metadata-only; never replace this with an index rebuild.
ALTER TABLE "interactions" RENAME COLUMN "execution_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" RENAME COLUMN "execution_id" TO "run_id";--> statement-breakpoint
ALTER TABLE "runtime_credential_connections" RENAME CONSTRAINT "execution_credential_connections_scope_check" TO "runtime_credential_connections_scope_check";--> statement-breakpoint
ALTER TABLE "runtime_credential_connections" RENAME CONSTRAINT "execution_credential_connections_owner_check" TO "runtime_credential_connections_owner_check";--> statement-breakpoint
ALTER TABLE "runtime_credential_definitions" RENAME CONSTRAINT "execution_credential_definitions_scope_check" TO "runtime_credential_definitions_scope_check";--> statement-breakpoint
ALTER TABLE "agent_run_inputs" RENAME CONSTRAINT "agent_execution_inputs_task_id_a2a_task_id_fk" TO "agent_run_inputs_task_id_a2a_task_id_fk";--> statement-breakpoint
ALTER TABLE "agent_run_inputs" RENAME CONSTRAINT "agent_execution_inputs_uploaded_by_user_id_user_id_fk" TO "agent_run_inputs_uploaded_by_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "agents_background_execution_secret_id_secret_id_fk" TO "agents_runtime_secret_id_secret_id_fk";--> statement-breakpoint
ALTER TABLE "runtime_credential_connections" RENAME CONSTRAINT "execution_credential_connections_user_id_user_id_fk" TO "runtime_credential_connections_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "runtime_credential_connections" RENAME CONSTRAINT "execution_credential_connections_secret_id_secret_id_fk" TO "runtime_credential_connections_secret_id_secret_id_fk";--> statement-breakpoint
ALTER TABLE "runtime_credential_definitions" RENAME CONSTRAINT "execution_credential_definitions_created_by_user_id_fk" TO "runtime_credential_definitions_created_by_user_id_fk";--> statement-breakpoint
ALTER INDEX "agent_execution_inputs_task_id_idx" RENAME TO "agent_run_inputs_task_id_idx";--> statement-breakpoint
ALTER INDEX "agent_execution_inputs_organization_id_idx" RENAME TO "agent_run_inputs_organization_id_idx";--> statement-breakpoint
ALTER INDEX "agent_execution_inputs_task_path_uidx" RENAME TO "agent_run_inputs_task_path_uidx";--> statement-breakpoint
ALTER INDEX "execution_credential_connections_org_idx" RENAME TO "runtime_credential_connections_org_idx";--> statement-breakpoint
ALTER INDEX "execution_credential_connections_user_idx" RENAME TO "runtime_credential_connections_user_idx";--> statement-breakpoint
ALTER INDEX "execution_credential_connections_personal_uidx" RENAME TO "runtime_credential_connections_personal_uidx";--> statement-breakpoint
ALTER INDEX "execution_credential_connections_organization_uidx" RENAME TO "runtime_credential_connections_organization_uidx";--> statement-breakpoint
ALTER INDEX "execution_credential_definitions_org_idx" RENAME TO "runtime_credential_definitions_org_idx";--> statement-breakpoint
ALTER INDEX "execution_credential_definitions_org_key_uidx" RENAME TO "runtime_credential_definitions_org_key_uidx";--> statement-breakpoint
ALTER INDEX "agent_runs_deployment_name_uidx" RENAME TO "agent_runs_workload_name_uidx";--> statement-breakpoint
ALTER INDEX "interactions_execution_id_idx" RENAME TO "interactions_run_id_idx";--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "title" SET DEFAULT 'Run';--> statement-breakpoint
