CREATE TABLE "chatops_channel_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"channel_id" varchar(256) NOT NULL,
	"workspace_id" varchar(256),
	"prompt_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatops_processed_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" varchar(512) NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chatops_processed_message_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "allowed_chatops" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chatops_channel_binding" ADD CONSTRAINT "chatops_channel_binding_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_channel_binding_provider_channel_workspace_idx" ON "chatops_channel_binding" USING btree ("provider","channel_id","workspace_id");--> statement-breakpoint
CREATE INDEX "chatops_channel_binding_organization_id_idx" ON "chatops_channel_binding" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "chatops_channel_binding_prompt_id_idx" ON "chatops_channel_binding" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX "chatops_processed_message_processed_at_idx" ON "chatops_processed_message" USING btree ("processed_at");