-- Better Auth API key migration reference:
-- https://better-auth.com/docs/plugins/api-key/reference#migration-from-previous-versions
ALTER TABLE "apikey" ADD COLUMN "config_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "reference_id" text;--> statement-breakpoint
UPDATE "apikey" SET "reference_id" = "user_id" WHERE "reference_id" IS NULL;--> statement-breakpoint
ALTER TABLE "apikey" ALTER COLUMN "reference_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_apikey_reference_id" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "idx_apikey_config_id" ON "apikey" USING btree ("config_id");--> statement-breakpoint
ALTER TABLE "apikey" DROP CONSTRAINT "apikey_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "apikey" DROP COLUMN "user_id";
