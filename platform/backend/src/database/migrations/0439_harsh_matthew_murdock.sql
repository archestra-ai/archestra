-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=brand-new table (agent_excluded_connectors) has no existing rows, so its FK constraints cannot fail on any data; CASCADE deletes are intentional (an exclusion row is meaningless without its agent/connector).
CREATE TABLE "agent_excluded_connectors" (
	"agent_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_excluded_connectors_agent_id_connector_id_pk" PRIMARY KEY("agent_id","connector_id")
);
--> statement-breakpoint
ALTER TABLE "agent_excluded_connectors" ADD CONSTRAINT "agent_excluded_connectors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_excluded_connectors" ADD CONSTRAINT "agent_excluded_connectors_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;