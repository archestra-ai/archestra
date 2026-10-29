ALTER TABLE "connection_setups" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD COLUMN "revoked_by_user_id" text;--> statement-breakpoint
ALTER TABLE "connection_setups" ADD CONSTRAINT "connection_setups_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "connection_setups" VALIDATE CONSTRAINT "connection_setups_revoked_by_user_id_user_id_fk";
