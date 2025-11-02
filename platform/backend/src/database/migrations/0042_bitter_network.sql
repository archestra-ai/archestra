CREATE TABLE "limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"entity_type" varchar NOT NULL,
	"entity_id" text NOT NULL,
	"limit_type" varchar NOT NULL,
	"limit_value" integer NOT NULL,
	"current_usage" integer DEFAULT 0 NOT NULL,
	"mcp_server_name" varchar(255),
	"tool_name" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "limits_entity_idx" ON "limits" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "limits_type_idx" ON "limits" USING btree ("limit_type");