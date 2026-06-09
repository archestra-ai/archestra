CREATE TABLE "network_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"egress_mode" text DEFAULT 'restricted' NOT NULL,
	"domain_preset" text DEFAULT 'none' NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "network_policy_org_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "network_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_network_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "network_policies" ADD CONSTRAINT "network_policies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_policy_org_idx" ON "network_policies" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_network_policy_id_network_policies_id_fk" FOREIGN KEY ("network_policy_id") REFERENCES "public"."network_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_network_policy_id_network_policies_id_fk" FOREIGN KEY ("default_network_policy_id") REFERENCES "public"."network_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "environments_network_policy_id_idx" ON "environments" USING btree ("network_policy_id");