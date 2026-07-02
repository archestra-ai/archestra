CREATE TABLE "onboarding_survey_submissions" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"submitted_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_onboarding_steps" (
	"user_id" text NOT NULL,
	"step_key" text NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_onboarding_steps_user_id_step_key_pk" PRIMARY KEY("user_id","step_key")
);
--> statement-breakpoint
ALTER TABLE "onboarding_survey_submissions" ADD CONSTRAINT "onboarding_survey_submissions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_survey_submissions" ADD CONSTRAINT "onboarding_survey_submissions_submitted_by_user_id_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_onboarding_steps" ADD CONSTRAINT "user_onboarding_steps_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;