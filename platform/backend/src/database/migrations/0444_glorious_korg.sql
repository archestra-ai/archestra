-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both execution credential tables are created empty in this migration, so their constraints and indexes validate without scanning existing rows or blocking existing writers. CASCADE intentionally removes personal connection references with their user and secret records with their secret-manager metadata.
CREATE TABLE "execution_credential_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"credential_id" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_credential_connections_scope_check" CHECK ("execution_credential_connections"."scope" in ('personal', 'organization')),
	CONSTRAINT "execution_credential_connections_owner_check" CHECK (("execution_credential_connections"."scope" = 'personal' and "execution_credential_connections"."user_id" is not null) or ("execution_credential_connections"."scope" = 'organization' and "execution_credential_connections"."user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "execution_credential_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text,
	"allow_personal" boolean DEFAULT true NOT NULL,
	"allow_organization" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_credential_definitions_scope_check" CHECK (("execution_credential_definitions"."allow_personal" and not "execution_credential_definitions"."allow_organization") or ("execution_credential_definitions"."allow_organization" and not "execution_credential_definitions"."allow_personal"))
);
--> statement-breakpoint
ALTER TABLE "execution_credential_connections" ADD CONSTRAINT "execution_credential_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_credential_connections" ADD CONSTRAINT "execution_credential_connections_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_credential_definitions" ADD CONSTRAINT "execution_credential_definitions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_credential_connections_org_idx" ON "execution_credential_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "execution_credential_connections_user_idx" ON "execution_credential_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_credential_connections_personal_uidx" ON "execution_credential_connections" USING btree ("organization_id","user_id","credential_id") WHERE "execution_credential_connections"."scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "execution_credential_connections_organization_uidx" ON "execution_credential_connections" USING btree ("organization_id","credential_id") WHERE "execution_credential_connections"."scope" = 'organization';--> statement-breakpoint
CREATE INDEX "execution_credential_definitions_org_idx" ON "execution_credential_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_credential_definitions_org_key_uidx" ON "execution_credential_definitions" USING btree ("organization_id","key");
