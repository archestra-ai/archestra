-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Constraints and indexes apply only to the empty checkpoint binding table created in this migration. Existing APPA tables and records are not rewritten.
CREATE TABLE "appa_proxy_checkpoint_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_session_id" uuid NOT NULL,
	"source_frame_id" uuid NOT NULL,
	"runtime_event_id" uuid NOT NULL,
	"checkpoint_id" text NOT NULL,
	"checkpoint_position" integer NOT NULL,
	"checkpoint_digest" text NOT NULL,
	"provider" text NOT NULL,
	"protocol" text NOT NULL,
	"model" text NOT NULL,
	"bootstrap_digest" text,
	"request_prefix_hash" text NOT NULL,
	"inherited_prefix_hash" text NOT NULL,
	"history_ciphertext" text NOT NULL,
	"history_hash" text NOT NULL,
	"history_bytes" integer NOT NULL,
	"issued_items_digest" text NOT NULL,
	"actual_response_hash" text NOT NULL,
	"terminal_omission" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'bound' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appa_proxy_checkpoint_bindings" ADD CONSTRAINT "appa_proxy_checkpoint_bindings_source_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_checkpoint_bindings" ADD CONSTRAINT "appa_proxy_checkpoint_bindings_source_frame_id_appa_proxy_wire_frames_id_fk" FOREIGN KEY ("source_frame_id") REFERENCES "public"."appa_proxy_wire_frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_checkpoint_bindings_session_checkpoint_uidx" ON "appa_proxy_checkpoint_bindings" USING btree ("source_session_id","checkpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_checkpoint_bindings_frame_uidx" ON "appa_proxy_checkpoint_bindings" USING btree ("source_frame_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_checkpoint_bindings_lookup_idx" ON "appa_proxy_checkpoint_bindings" USING btree ("provider","protocol","model","bootstrap_digest");
