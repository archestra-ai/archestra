CREATE TABLE "token_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" varchar(255) NOT NULL,
	"price_per_million_input" numeric(10, 2) NOT NULL,
	"price_per_million_output" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "token_price_model_unique" UNIQUE("model")
);
--> statement-breakpoint
CREATE INDEX "token_price_model_idx" ON "token_price" USING btree ("model");