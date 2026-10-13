-- Pending receipts written before this migration keep no lease, so the next claim of each
-- takes it over at once, as a dispatch of the previous version would have. Only rows written
-- afterwards get the default.
CREATE TABLE "openappa_peer_inboxes" (
	"receiver" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openappa_roots" (
	"root" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "openappa_operations" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "openappa_operations" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "openappa_operations" ALTER COLUMN "lease_expires_at" SET DEFAULT now() + interval '15 minutes';--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ALTER COLUMN "lease_expires_at" SET DEFAULT now() + interval '15 minutes';--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ADD COLUMN "completed_at" timestamp with time zone;