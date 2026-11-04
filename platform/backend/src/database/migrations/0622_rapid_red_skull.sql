ALTER TABLE "virtual_api_keys" ADD COLUMN "rotation_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "rotation_grace_period_seconds" integer;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "next_rotation_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "last_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "rotation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "previous_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "previous_token_start" varchar(16);--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "previous_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD CONSTRAINT "virtual_api_keys_previous_secret_id_secret_id_fk" FOREIGN KEY ("previous_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" VALIDATE CONSTRAINT "virtual_api_keys_previous_secret_id_secret_id_fk";--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_previous_token_start" ON "virtual_api_keys" USING btree ("previous_token_start") WHERE "virtual_api_keys"."previous_token_start" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_next_rotation_at" ON "virtual_api_keys" USING btree ("next_rotation_at") WHERE "virtual_api_keys"."next_rotation_at" IS NOT NULL;