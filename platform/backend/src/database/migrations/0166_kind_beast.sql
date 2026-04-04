CREATE TYPE "public"."mcp_catalog_scope" AS ENUM('personal', 'team', 'org');--> statement-breakpoint
CREATE TABLE "mcp_catalog_team" (
	"catalog_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_catalog_team_catalog_id_team_id_pk" PRIMARY KEY("catalog_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "scope" "mcp_catalog_scope" DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_catalog_team" ADD CONSTRAINT "mcp_catalog_team_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_catalog_team" ADD CONSTRAINT "mcp_catalog_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_organization_id_idx" ON "internal_mcp_catalog" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_author_id_idx" ON "internal_mcp_catalog" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "internal_mcp_catalog_scope_idx" ON "internal_mcp_catalog" USING btree ("scope");