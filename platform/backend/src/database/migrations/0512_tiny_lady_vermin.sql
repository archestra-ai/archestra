CREATE TABLE "openappa_native_deliveries" (
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event_id" text NOT NULL,
	"room_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_native_deliveries_organization_id_session_id_event_id_pk" PRIMARY KEY("organization_id","session_id","event_id"),
	CONSTRAINT "openappa_native_deliveries_status" CHECK ("openappa_native_deliveries"."status" IN ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "openappa_native_rooms" (
	"room_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"trust" text NOT NULL,
	"readers_status" text NOT NULL,
	"readers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_native_rooms_trust" CHECK ("openappa_native_rooms"."trust" IN ('trusted', 'suspicious')),
	CONSTRAINT "openappa_native_rooms_readers" CHECK (("openappa_native_rooms"."readers_status" = 'unresolved' AND "openappa_native_rooms"."readers" IS NULL) OR ("openappa_native_rooms"."readers_status" = 'resolved' AND "openappa_native_rooms"."readers" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "openappa_review_continuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"approval_id" text NOT NULL,
	"approved" boolean NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"origin" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"claim_id" uuid,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	"delivery_event_id" text,
	"failure_reason" text,
	CONSTRAINT "openappa_review_continuation_approval_idx" UNIQUE("task_id","approval_id"),
	CONSTRAINT "openappa_review_continuations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "openappa_review_continuations_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "openappa_review_continuations_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "openappa_native_rooms_org_idx" ON "openappa_native_rooms" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "openappa_review_continuation_work_idx" ON "openappa_review_continuations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "agent_runs_credential_lease_idx" ON "agent_runs" USING btree ("organization_id","virtual_api_key_id","started_at","id");
