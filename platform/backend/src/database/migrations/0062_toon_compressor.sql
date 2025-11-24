ALTER TABLE "agents" ADD COLUMN "convert_tool_results_to_toon" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "processed_request" jsonb;