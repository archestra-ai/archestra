ALTER TABLE "agents" ADD COLUMN "incoming_email_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "incoming_email_security_mode" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "incoming_email_allowed_domain" text;