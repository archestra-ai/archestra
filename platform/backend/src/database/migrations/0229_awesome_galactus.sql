CREATE TABLE "a2a_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"task_id" uuid,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_task_approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"approval_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "a2a_message" ADD CONSTRAINT "a2a_message_context_id_a2a_context_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."a2a_context"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_message" ADD CONSTRAINT "a2a_message_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task_approval_request" ADD CONSTRAINT "a2a_task_approval_request_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_context_id_a2a_context_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."a2a_context"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_context_actor_kind_id_idx" ON "a2a_context" USING btree ("actor_kind","actor_id");--> statement-breakpoint
CREATE INDEX "a2a_context_updated_at_idx" ON "a2a_context" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "a2a_message_context_id_idx" ON "a2a_message" USING btree ("context_id","created_at");--> statement-breakpoint
CREATE INDEX "a2a_message_task_id_idx" ON "a2a_message" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "a2a_message_updated_at_idx" ON "a2a_message" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "a2a_task_approval_request_task_id_approval_id_idx" ON "a2a_task_approval_request" USING btree ("task_id","approval_id");--> statement-breakpoint
CREATE INDEX "a2a_task_context_id_idx" ON "a2a_task" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX "a2a_task_updated_at_idx" ON "a2a_task" USING btree ("updated_at");