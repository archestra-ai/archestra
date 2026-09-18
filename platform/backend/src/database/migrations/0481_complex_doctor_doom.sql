ALTER TABLE "organization" ADD COLUMN "connection_runtime_handoff_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "connection_runtime_handoff_instructions" text;
