SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "duration_ms" integer;
