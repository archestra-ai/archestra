-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys and unique index target a table created empty in this migration, so validation scans no existing rows. ON DELETE CASCADE intentionally removes a reset marker with its organization or user. The new table and the nullable limits.reason column are additive and ignored by older releases.
CREATE TABLE "user_limit_usage_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reset_at" timestamp NOT NULL,
	"reset_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "limits" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "user_limit_usage_resets" ADD CONSTRAINT "user_limit_usage_resets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_limit_usage_resets" ADD CONSTRAINT "user_limit_usage_resets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_limit_usage_resets" ADD CONSTRAINT "user_limit_usage_resets_reset_by_user_id_user_id_fk" FOREIGN KEY ("reset_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_limit_usage_resets_org_user_unique" ON "user_limit_usage_resets" USING btree ("organization_id","user_id");