CREATE TABLE "browser_tab_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"isolation_key" text NOT NULL,
	"url" text,
	"tab_index" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_tab_states" ADD CONSTRAINT "browser_tab_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tab_states" ADD CONSTRAINT "browser_tab_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_tab_states_agent_user_isolation_idx" ON "browser_tab_states" USING btree ("agent_id","user_id","isolation_key");--> statement-breakpoint
CREATE INDEX "browser_tab_states_user_id_idx" ON "browser_tab_states" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "browser_state";