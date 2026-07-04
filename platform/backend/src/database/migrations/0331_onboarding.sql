CREATE TABLE "user_onboarding_seen_items" (
	"user_id" text NOT NULL,
	"item" text NOT NULL,
	"seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_onboarding_seen_items_user_id_item_pk" PRIMARY KEY("user_id","item")
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "onboarding_survey_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_onboarding_seen_items" ADD CONSTRAINT "user_onboarding_seen_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action NOT VALID;