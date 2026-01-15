CREATE TABLE "incoming_email_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" varchar(256) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"webhook_url" varchar(1024) NOT NULL,
	"client_state" varchar(256) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
