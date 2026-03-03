CREATE TABLE "connector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"documents_processed" integer DEFAULT 0,
	"documents_ingested" integer DEFAULT 0,
	"error" text,
	"checkpoint" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_graph_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"knowledge_graph_id" uuid NOT NULL,
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
CREATE TABLE "knowledge_graphs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"seeded_from_env" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_connector_id_knowledge_graph_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_graph_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_connectors" ADD CONSTRAINT "knowledge_graph_connectors_knowledge_graph_id_knowledge_graphs_id_fk" FOREIGN KEY ("knowledge_graph_id") REFERENCES "public"."knowledge_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graph_connectors" ADD CONSTRAINT "knowledge_graph_connectors_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_graphs" ADD CONSTRAINT "knowledge_graphs_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_runs_connector_id_idx" ON "connector_runs" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "knowledge_graph_connectors_knowledge_graph_id_idx" ON "knowledge_graph_connectors" USING btree ("knowledge_graph_id");--> statement-breakpoint
CREATE INDEX "knowledge_graph_connectors_organization_id_idx" ON "knowledge_graph_connectors" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_graphs_organization_id_idx" ON "knowledge_graphs" USING btree ("organization_id");