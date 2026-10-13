CREATE TABLE "openappa_thread_states" (
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"root_message_id" text NOT NULL,
	"tools" jsonb,
	"calls" jsonb,
	"diverged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_thread_states_organization_id_message_id_pk" PRIMARY KEY("organization_id","message_id")
);
--> statement-breakpoint
CREATE INDEX "openappa_thread_states_created_at_idx" ON "openappa_thread_states" USING btree ("created_at");