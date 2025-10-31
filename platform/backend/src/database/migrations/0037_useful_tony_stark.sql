CREATE TABLE "token_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"model" varchar(200) NOT NULL,
	"input_price_per_1m" numeric(10, 2) DEFAULT '50.00' NOT NULL,
	"output_price_per_1m" numeric(10, 2) DEFAULT '50.00' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_model_unique" UNIQUE("provider","model")
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "provider" varchar(50);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "model" varchar(100);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
CREATE INDEX "interactions_provider_idx" ON "interactions" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "interactions_model_idx" ON "interactions" USING btree ("model");