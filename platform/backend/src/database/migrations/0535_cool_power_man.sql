CREATE TABLE "browser_storage_states" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encrypted_state" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_storage_states" ADD CONSTRAINT "browser_storage_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "browser_storage_states" VALIDATE CONSTRAINT "browser_storage_states_user_id_user_id_fk";