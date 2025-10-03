ALTER TABLE "interactions" RENAME COLUMN "taint_reason" TO "reason";--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trusted_data_policies" ADD COLUMN "action" text DEFAULT 'allow' NOT NULL;