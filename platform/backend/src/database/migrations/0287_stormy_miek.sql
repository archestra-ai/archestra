ALTER TABLE "app_data" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_data" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "app_data" ADD CONSTRAINT "app_data_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "app_data" VALIDATE CONSTRAINT "app_data_owner_user_id_user_id_fk";