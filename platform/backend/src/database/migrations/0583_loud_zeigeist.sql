-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both accounting tables are created empty in this migration, so the new index and foreign key validation scan no existing rows. The foreign key briefly locks limits to attach its trigger. No interaction table or index is changed. Deleting a limit intentionally removes only its derived budget projection. Receipts have no foreign key and survive log retention.
CREATE TABLE "interaction_billing" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"usage" jsonb NOT NULL,
	"organization_id" text,
	"user_id" text,
	"environment_id" uuid,
	"billing_mode" text NOT NULL,
	"billing_team_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "limit_billing_usage" (
	"limit_id" uuid NOT NULL,
	"model" varchar(255) NOT NULL,
	"covered_tokens_in" bigint DEFAULT 0 NOT NULL,
	"covered_tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost" numeric(24, 10) DEFAULT '0' NOT NULL,
	"incomplete" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "limit_billing_usage_limit_id_model_pk" PRIMARY KEY("limit_id","model")
);
--> statement-breakpoint
ALTER TABLE "limit_billing_usage" ADD CONSTRAINT "limit_billing_usage_limit_id_limits_id_fk" FOREIGN KEY ("limit_id") REFERENCES "public"."limits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_billing_user_period_idx" ON "interaction_billing" USING btree ("organization_id","user_id","created_at");