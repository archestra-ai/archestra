CREATE TABLE "chatops_user_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chatops_user_admissions" ADD CONSTRAINT "chatops_user_admissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chatops_user_admissions" VALIDATE CONSTRAINT "chatops_user_admissions_user_id_user_id_fk";--> statement-breakpoint
CREATE INDEX "chatops_user_admissions_user_id_idx" ON "chatops_user_admissions" USING btree ("user_id");