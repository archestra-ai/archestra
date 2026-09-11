-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every constraint and index here targets agent_pins, a table created empty in this same migration (mirrors project_pins): validating the foreign keys scans no existing rows, and CONCURRENTLY is unnecessary on a brand-new empty table. ON DELETE cascade is intentional because a pin is meaningless without its parent user or agent.
CREATE TABLE "agent_pins" (
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"pinned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_pins_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "agent_pins" ADD CONSTRAINT "agent_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pins" ADD CONSTRAINT "agent_pins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_pins_agent_id_idx" ON "agent_pins" USING btree ("agent_id");
