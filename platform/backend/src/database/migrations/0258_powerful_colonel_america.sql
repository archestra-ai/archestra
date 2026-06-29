CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_type" text NOT NULL,
	"actor_name" text,
	"actor_email" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"http_method" text,
	"http_path" text,
	"http_route" text,
	"http_status" integer,
	"request_id" text,
	"source_ip" "inet",
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_at_seq_idx" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST,"event_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_org_actor_created_at_idx" ON "audit_logs" USING btree ("organization_id","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_org_resource_idx" ON "audit_logs" USING btree ("organization_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_action_created_at_idx" ON "audit_logs" USING btree ("organization_id","action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_org_outcome_created_at_idx" ON "audit_logs" USING btree ("organization_id","outcome","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");