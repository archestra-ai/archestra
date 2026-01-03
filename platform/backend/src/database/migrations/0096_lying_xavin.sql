CREATE TABLE "user_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(256) NOT NULL,
	"secret_id" uuid NOT NULL,
	"token_start" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "user_token_organization_id_user_id_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_token" ADD CONSTRAINT "user_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_token" ADD CONSTRAINT "user_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_token" ADD CONSTRAINT "user_token_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_token_org_id" ON "user_token" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_user_token_user_id" ON "user_token" USING btree ("user_id");