CREATE TABLE "openappa_events" (
	"root" text NOT NULL,
	"seq" bigint NOT NULL,
	"payload" "bytea" NOT NULL,
	CONSTRAINT "openappa_events_root_seq_pk" PRIMARY KEY("root","seq"),
	CONSTRAINT "openappa_events_seq_nonnegative" CHECK ("openappa_events"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "openappa_operations" (
	"organization_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"session_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"root" text NOT NULL,
	"status" text NOT NULL,
	"input" jsonb NOT NULL,
	"decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_operations_pk" PRIMARY KEY("organization_id","caller_id","session_id","operation_id"),
	CONSTRAINT "openappa_operations_status" CHECK (("openappa_operations"."status" = 'pending' AND "openappa_operations"."decision" IS NULL) OR ("openappa_operations"."status" = 'complete' AND "openappa_operations"."decision" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "openappa_policy_files" (
	"hash" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openappa_processed_results" (
	"organization_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"root" text NOT NULL,
	"status" text NOT NULL,
	"approved_output" text,
	"decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_results_pk" PRIMARY KEY("organization_id","caller_id","session_id","tool_call_id"),
	CONSTRAINT "openappa_results_status" CHECK (("openappa_processed_results"."status" = 'pending' AND "openappa_processed_results"."approved_output" IS NULL AND "openappa_processed_results"."decision" IS NULL) OR ("openappa_processed_results"."status" = 'complete' AND "openappa_processed_results"."approved_output" IS NOT NULL AND "openappa_processed_results"."decision" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "openappa_sessions" (
	"actor" text PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"organization_id" text NOT NULL,
	"caller_id" text NOT NULL,
	"session_id" text NOT NULL,
	"parent_id" text,
	"start_decision" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openappa_operations_pending_idx" ON "openappa_operations" USING btree ("root") WHERE "openappa_operations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "openappa_results_pending_idx" ON "openappa_processed_results" USING btree ("root") WHERE "openappa_processed_results"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "openappa_sessions_root_idx" ON "openappa_sessions" USING btree ("root");