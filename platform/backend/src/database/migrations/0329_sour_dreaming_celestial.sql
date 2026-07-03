-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every constraint and index here targets app_pins, a table created empty in this same migration (mirrors project_pins in 0306): the add-validating-constraint and add-unique-constraint rules scan no existing rows, and CONCURRENTLY is unnecessary on a brand-new empty table. ON DELETE cascade is intentional (a pin is meaningless without its parent user/app/install).
CREATE TABLE "app_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"app_id" uuid,
	"mcp_server_id" uuid,
	"resource_uri" text,
	"pinned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_pins" ADD CONSTRAINT "app_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_pins" ADD CONSTRAINT "app_pins_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_pins" ADD CONSTRAINT "app_pins_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_pins_user_app_uidx" ON "app_pins" USING btree ("user_id","app_id") WHERE "app_pins"."app_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "app_pins_user_external_uidx" ON "app_pins" USING btree ("user_id","mcp_server_id","resource_uri") WHERE "app_pins"."mcp_server_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "app_pins_app_id_idx" ON "app_pins" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "app_pins_mcp_server_id_idx" ON "app_pins" USING btree ("mcp_server_id");