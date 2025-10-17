ALTER TABLE "tools" ADD COLUMN "tool_result_treatment" text DEFAULT 'untrusted' NOT NULL;--> statement-breakpoint
ALTER TABLE "tools" DROP COLUMN "data_is_trusted_by_default";