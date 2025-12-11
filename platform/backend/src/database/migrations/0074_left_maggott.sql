ALTER TABLE "organization" ALTER COLUMN "convert_tool_results_to_toon" SET DEFAULT true;--> statement-breakpoint
UPDATE "organization" SET "convert_tool_results_to_toon" = true;