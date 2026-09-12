-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints and indexes target the nine new empty APPA proxy tables created in this migration. No existing tables, existing rows, or older writers are modified.
CREATE TABLE "appa_proxy_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"active_turn_id" text NOT NULL,
	"candidate_call_id" text NOT NULL,
	"root_id" text NOT NULL,
	"tool" text NOT NULL,
	"arguments_sha256" text NOT NULL,
	"offer_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"approver_id" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_history_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"protocol" text NOT NULL,
	"model" text NOT NULL,
	"provider_item_id" text,
	"server_identity" text NOT NULL,
	"item_type" text NOT NULL,
	"source_turn_id" text NOT NULL,
	"identity_hash" text NOT NULL,
	"canonical_payload_encrypted" text NOT NULL,
	"canonical_payload_bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appa_proxy_history_items_payload_bytes_check" CHECK ("appa_proxy_history_items"."canonical_payload_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_history_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"protocol" text NOT NULL,
	"model" text NOT NULL,
	"provider_window_id" text NOT NULL,
	"frame_version" integer NOT NULL,
	"source_turn_id" text NOT NULL,
	"parent_window_id" uuid,
	"bound_by_server_identity" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appa_proxy_history_windows_frame_version_check" CHECK ("appa_proxy_history_windows"."frame_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"emitted_name" text NOT NULL,
	"emitted_arguments" text NOT NULL,
	"emitted_arguments_canonical" text NOT NULL,
	"appa_target_name" text NOT NULL,
	"appa_target_arguments" jsonb NOT NULL,
	"dispatch_id" text,
	"spawn_binding" text,
	"spawn_binding_consumed_at" timestamp,
	"state" text NOT NULL,
	"result_hash" text,
	"result_status" text,
	"result_message_hash" text,
	"result_presentation" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appa_proxy_calls_state_check" CHECK ("appa_proxy_calls"."state" in ('authorization_intent', 'open', 'result_intent', 'result_admitted', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event" text NOT NULL,
	"request_body" text NOT NULL,
	"request_sha256" text NOT NULL,
	"response" jsonb,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"owner_scope_hash" text NOT NULL,
	"client_session_id" text NOT NULL,
	"provider" text,
	"protocol" text,
	"model" text,
	"root_id" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"active_turn_id" text,
	"pending_remote_event" text,
	"root_initialized_at" timestamp,
	"parent_session_id" uuid,
	"parent_call_id" text,
	"child_started_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appa_proxy_sessions_state_check" CHECK ("appa_proxy_sessions"."state" in ('ready', 'in_turn', 'quarantined'))
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_wire_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"frame_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"wire_id" text NOT NULL,
	"logical_id" text,
	"source_call_id" text,
	"metadata_ciphertext" text NOT NULL,
	"metadata_bytes" integer NOT NULL,
	"child_thread_id" text,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appa_proxy_wire_aliases_kind_check" CHECK ("appa_proxy_wire_aliases"."kind" in ('call','task','process')),
	CONSTRAINT "appa_proxy_wire_aliases_position_check" CHECK ("appa_proxy_wire_aliases"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "appa_proxy_wire_frames" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_frame_id" uuid,
	"turn_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"protocol" text NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_response_id" text,
	"control_call_id" text,
	"runtime_batch_id" text,
	"payload_ciphertext" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_bytes" integer NOT NULL,
	"receipt_ciphertext" text,
	"receipt_hash" text,
	"receipt_bytes" integer DEFAULT 0 NOT NULL,
	"execution_event_id" uuid,
	"execution_request_hash" text,
	"issued_at" timestamp,
	"completed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "appa_proxy_wire_frames_state_check" CHECK ("appa_proxy_wire_frames"."state" in ('held','ready','issued','running','completed','cancelled','quarantined')),
	CONSTRAINT "appa_proxy_wire_frames_kind_check" CHECK ("appa_proxy_wire_frames"."kind" in ('model_response','inbound_hold','remedy_control')),
	CONSTRAINT "appa_proxy_wire_frames_bytes_check" CHECK ("appa_proxy_wire_frames"."payload_bytes" >= 0 and "appa_proxy_wire_frames"."payload_bytes" <= 16777216)
);
--> statement-breakpoint
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
ALTER TABLE "appa_proxy_approvals" ADD CONSTRAINT "appa_proxy_approvals_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_history_items" ADD CONSTRAINT "appa_proxy_history_items_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_history_items" ADD CONSTRAINT "appa_proxy_history_items_window_id_appa_proxy_history_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."appa_proxy_history_windows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_history_windows" ADD CONSTRAINT "appa_proxy_history_windows_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_history_windows" ADD CONSTRAINT "appa_proxy_history_windows_parent_window_id_appa_proxy_history_windows_id_fk" FOREIGN KEY ("parent_window_id") REFERENCES "public"."appa_proxy_history_windows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_calls" ADD CONSTRAINT "appa_proxy_calls_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_events" ADD CONSTRAINT "appa_proxy_events_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_sessions" ADD CONSTRAINT "appa_proxy_sessions_parent_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_wire_aliases" ADD CONSTRAINT "appa_proxy_wire_aliases_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_wire_aliases" ADD CONSTRAINT "appa_proxy_wire_aliases_frame_id_appa_proxy_wire_frames_id_fk" FOREIGN KEY ("frame_id") REFERENCES "public"."appa_proxy_wire_frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_wire_frames" ADD CONSTRAINT "appa_proxy_wire_frames_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_wire_frames" ADD CONSTRAINT "appa_proxy_wire_frames_parent_frame_id_appa_proxy_wire_frames_id_fk" FOREIGN KEY ("parent_frame_id") REFERENCES "public"."appa_proxy_wire_frames"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_checkpoint_bindings" ADD CONSTRAINT "appa_proxy_checkpoint_bindings_source_session_id_appa_proxy_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."appa_proxy_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appa_proxy_checkpoint_bindings" ADD CONSTRAINT "appa_proxy_checkpoint_bindings_source_frame_id_appa_proxy_wire_frames_id_fk" FOREIGN KEY ("source_frame_id") REFERENCES "public"."appa_proxy_wire_frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appa_proxy_approvals_org_status_idx" ON "appa_proxy_approvals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "appa_proxy_approvals_session_turn_idx" ON "appa_proxy_approvals" USING btree ("session_id","active_turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_history_items_scope_provider_item_uidx" ON "appa_proxy_history_items" USING btree ("session_id","provider","protocol","model","provider_item_id") WHERE "appa_proxy_history_items"."provider_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_history_items_scope_identity_uidx" ON "appa_proxy_history_items" USING btree ("session_id","provider","protocol","model","identity_hash");--> statement-breakpoint
CREATE INDEX "appa_proxy_history_items_window_idx" ON "appa_proxy_history_items" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_history_items_session_turn_idx" ON "appa_proxy_history_items" USING btree ("session_id","source_turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_history_items_server_identity_uidx" ON "appa_proxy_history_items" USING btree ("server_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_history_windows_scope_window_uidx" ON "appa_proxy_history_windows" USING btree ("session_id","provider","protocol","model","provider_window_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_history_windows_session_frame_uidx" ON "appa_proxy_history_windows" USING btree ("session_id","frame_version");--> statement-breakpoint
CREATE INDEX "appa_proxy_history_windows_session_turn_idx" ON "appa_proxy_history_windows" USING btree ("session_id","source_turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_history_windows_bound_item_uidx" ON "appa_proxy_history_windows" USING btree ("session_id","bound_by_server_identity") WHERE "appa_proxy_history_windows"."bound_by_server_identity" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_calls_session_call_uidx" ON "appa_proxy_calls" USING btree ("session_id","call_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_calls_session_state_idx" ON "appa_proxy_calls" USING btree ("session_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_events_event_id_uidx" ON "appa_proxy_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_events_session_id_idx" ON "appa_proxy_events" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_sessions_owner_session_uidx" ON "appa_proxy_sessions" USING btree ("owner_scope_hash","client_session_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_sessions_profile_id_idx" ON "appa_proxy_sessions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_sessions_parent_call_idx" ON "appa_proxy_sessions" USING btree ("parent_session_id","parent_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_wire_aliases_wire_uidx" ON "appa_proxy_wire_aliases" USING btree ("session_id","kind","wire_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_wire_aliases_position_uidx" ON "appa_proxy_wire_aliases" USING btree ("frame_id","kind","position");--> statement-breakpoint
CREATE INDEX "appa_proxy_wire_aliases_logical_idx" ON "appa_proxy_wire_aliases" USING btree ("session_id","kind","logical_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_wire_frames_session_idx" ON "appa_proxy_wire_frames" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_wire_frames_request_uidx" ON "appa_proxy_wire_frames" USING btree ("session_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_wire_frames_control_uidx" ON "appa_proxy_wire_frames" USING btree ("control_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_checkpoint_bindings_session_checkpoint_uidx" ON "appa_proxy_checkpoint_bindings" USING btree ("source_session_id","checkpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appa_proxy_checkpoint_bindings_frame_uidx" ON "appa_proxy_checkpoint_bindings" USING btree ("source_frame_id");--> statement-breakpoint
CREATE INDEX "appa_proxy_checkpoint_bindings_lookup_idx" ON "appa_proxy_checkpoint_bindings" USING btree ("provider","protocol","model","bootstrap_digest");