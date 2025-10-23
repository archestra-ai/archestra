CREATE TABLE "mcp_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"catalog_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "has_seeded_mcp_catalog" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_catalog_id_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."mcp_catalog"("id") ON DELETE set null ON UPDATE no action;