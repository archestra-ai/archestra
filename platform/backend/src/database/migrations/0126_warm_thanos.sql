CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"description" text,
	"context_length" integer,
	"input_modalities" jsonb,
	"output_modalities" jsonb,
	"supports_tool_calling" boolean,
	"prompt_price_per_token" numeric(20, 12),
	"completion_price_per_token" numeric(20, 12),
	"last_synced_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "models_provider_model_unique" UNIQUE("provider","model_id")
);
--> statement-breakpoint
CREATE INDEX "models_provider_model_idx" ON "models" USING btree ("provider","model_id");--> statement-breakpoint
CREATE INDEX "models_external_id_idx" ON "models" USING btree ("external_id");