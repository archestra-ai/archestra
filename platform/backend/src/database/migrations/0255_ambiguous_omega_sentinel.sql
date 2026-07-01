CREATE TABLE "skill_share_link_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"content_hash" text NOT NULL,
	"commit_sha" text NOT NULL,
	"parent_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_share_link_skill" (
	"share_link_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_share_link_skill_share_link_id_skill_id_pk" PRIMARY KEY("share_link_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_share_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_start" varchar(22) NOT NULL,
	"name" text,
	"marketplace_name" text NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_share_link_revision" ADD CONSTRAINT "skill_share_link_revision_link_id_skill_share_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."skill_share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link_skill" ADD CONSTRAINT "skill_share_link_skill_share_link_id_skill_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."skill_share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link_skill" ADD CONSTRAINT "skill_share_link_skill_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD CONSTRAINT "skill_share_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_share_link" ADD CONSTRAINT "skill_share_link_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_share_link_revision_link_seq_idx" ON "skill_share_link_revision" USING btree ("link_id","sequence");--> statement-breakpoint
CREATE INDEX "skill_share_link_revision_link_id_idx" ON "skill_share_link_revision" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "skill_share_link_skill_skill_id_idx" ON "skill_share_link_skill" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_share_link_token_hash_idx" ON "skill_share_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "skill_share_link_org_id_idx" ON "skill_share_link" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "skill_share_link_token_start_idx" ON "skill_share_link" USING btree ("token_start");