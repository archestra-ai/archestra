CREATE TABLE "limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" varchar NOT NULL,
	"entity_id" text NOT NULL,
	"limit_type" varchar NOT NULL,
	"limit_value" integer NOT NULL,
	"current_usage_tokens_in" integer DEFAULT 0 NOT NULL,
	"current_usage_tokens_out" integer DEFAULT 0 NOT NULL,
	"mcp_server_name" varchar(255),
	"tool_name" varchar(255),
	"model" varchar(255),
	"last_cleanup" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "organization" ADD COLUMN "limit_cleanup_interval" varchar DEFAULT '1h';--> statement-breakpoint
CREATE INDEX "limits_entity_idx" ON "limits" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "limits_type_idx" ON "limits" USING btree ("limit_type");--> statement-breakpoint
CREATE INDEX "token_price_model_idx" ON "token_price" USING btree ("model");