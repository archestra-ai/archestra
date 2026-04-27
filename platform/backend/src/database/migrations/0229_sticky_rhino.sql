ALTER TABLE "k8s_cluster" ALTER COLUMN "kubeconfig" SET DATA TYPE jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD COLUMN "is_personal_gateway" boolean DEFAULT false NOT NULL;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_server" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_personal_gateway_per_member_idx" ON "agents" USING btree ("organization_id","author_id") WHERE "agents"."agent_type" = 'mcp_gateway' AND "agents"."is_personal_gateway" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_server_scope_idx" ON "mcp_server" USING btree ("scope");--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" DROP COLUMN IF EXISTS "k8s_namespace";--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" DROP COLUMN IF EXISTS "k8s_cluster_id";