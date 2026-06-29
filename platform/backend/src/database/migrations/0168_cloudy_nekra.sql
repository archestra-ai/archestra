DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        CREATE EXTENSION IF NOT EXISTS vector;
    END IF;
EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'The pgvector extension is not installed and the current user lacks permission to create it. A superuser must run: CREATE EXTENSION vector;';
END
$$;
--> statement-breakpoint
CREATE TABLE "agent_connector_assignment" (
	"agent_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connector_assignment_agent_id_connector_id_pk" PRIMARY KEY("agent_id","connector_id")
);
--> statement-breakpoint
CREATE TABLE "agent_knowledge_base" (
	"agent_id" uuid NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_knowledge_base_agent_id_knowledge_base_id_pk" PRIMARY KEY("agent_id","knowledge_base_id")
);
--> statement-breakpoint
CREATE TABLE "connector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"documents_processed" integer DEFAULT 0,
	"documents_ingested" integer DEFAULT 0,
	"total_items" integer,
	"error" text,
	"logs" text,
	"checkpoint" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"content" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"embedding" vector(1536),
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	"acl" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"connector_id" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_url" text,
	"acl" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"embedding_status" text DEFAULT 'pending' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_connector_assignment" (
	"knowledge_base_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"connector_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_id" uuid,
	"schedule" text DEFAULT '0 */6 * * *' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_status" text,
	"last_sync_error" text,
	"checkpoint" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'org-wide' NOT NULL,
	"team_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "embedding_model" text DEFAULT 'text-embedding-3-small';--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "embedding_api_key_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_connector_assignment" ADD CONSTRAINT "agent_connector_assignment_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connector_assignment" ADD CONSTRAINT "agent_connector_assignment_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_base" ADD CONSTRAINT "agent_knowledge_base_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_base" ADD CONSTRAINT "agent_knowledge_base_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_connector_assignment" ADD CONSTRAINT "knowledge_base_connector_assignment_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_connector_assignment" ADD CONSTRAINT "knowledge_base_connector_assignment_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD CONSTRAINT "knowledge_base_connectors_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connector_assignment_agent_idx" ON "agent_connector_assignment" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_connector_assignment_connector_idx" ON "agent_connector_assignment" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_base_agent_idx" ON "agent_knowledge_base" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_base_kb_idx" ON "agent_knowledge_base" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "connector_runs_connector_id_idx" ON "connector_runs" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_document_id_idx" ON "kb_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "kb_documents_kb_id_idx" ON "kb_documents" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "kb_documents_org_id_idx" ON "kb_documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "kb_documents_content_hash_idx" ON "kb_documents" USING btree ("knowledge_base_id","content_hash");--> statement-breakpoint
CREATE INDEX "kb_documents_source_idx" ON "kb_documents" USING btree ("knowledge_base_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "kb_connector_assignment_kb_id_idx" ON "knowledge_base_connector_assignment" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "kb_connector_assignment_connector_id_idx" ON "knowledge_base_connector_assignment" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "knowledge_base_connectors_organization_id_idx" ON "knowledge_base_connectors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_bases_organization_id_idx" ON "knowledge_bases" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_embedding_api_key_secret_id_secret_id_fk" FOREIGN KEY ("embedding_api_key_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_chunks_embedding_idx" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE INDEX "kb_chunks_search_vector_idx" ON "kb_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "kb_chunks_acl_idx" ON "kb_chunks" USING gin ("acl" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "kb_documents_embedding_status_idx" ON "kb_documents" ("embedding_status") WHERE "embedding_status" != 'completed';