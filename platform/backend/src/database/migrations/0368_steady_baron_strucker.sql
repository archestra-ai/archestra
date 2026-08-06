-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=tool_observations is created empty in this same migration, so the validating FKs cannot fail existing rows and the index build takes no meaningful lock; cascade deletes only remove observation rows when their tool or user is deleted, which is the intended cleanup.
CREATE TABLE "tool_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"external_agent_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tool_observations_tool_id_user_id_external_agent_id_unique" UNIQUE("tool_id","user_id","external_agent_id")
);
--> statement-breakpoint
ALTER TABLE "tool_observations" ADD CONSTRAINT "tool_observations_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_observations" ADD CONSTRAINT "tool_observations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_observations_user_client_idx" ON "tool_observations" USING btree ("user_id","external_agent_id");