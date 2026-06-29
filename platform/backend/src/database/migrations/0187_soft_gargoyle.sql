ALTER TABLE "organization" ADD COLUMN "help_center_url" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "help_center_label" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "animate_chat_placeholders" boolean DEFAULT true NOT NULL;