ALTER TABLE "skills" ADD COLUMN "allowed_tools" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "templated" boolean DEFAULT false NOT NULL;