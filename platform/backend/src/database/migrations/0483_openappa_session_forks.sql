CREATE TABLE "openappa_context_anchors" (
	"organization_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"digest" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_context_anchors_pk" PRIMARY KEY("organization_id","caller_id","digest","session_id")
);
--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD COLUMN "forked_from" text;--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD COLUMN "forked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "openappa_sessions_forked_from_idx" ON "openappa_sessions" USING btree ("organization_id","forked_from");--> statement-breakpoint
CREATE INDEX "openappa_sessions_unscoped_session_idx" ON "openappa_sessions" USING btree ("organization_id",substr("session_id", strpos("session_id", '|') + 1));
