CREATE TABLE "local_device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text,
	"arch" text,
	"app_version" text,
	"pairing_hash" text,
	"pairing_expires_at" timestamp NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp,
	"session_id" uuid,
	"last_seen_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "local_device_pairing_hash_unique" UNIQUE("pairing_hash"),
	CONSTRAINT "local_device_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "local_device" ADD CONSTRAINT "local_device_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "local_device" ADD CONSTRAINT "local_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "local_device_owner_idx" ON "local_device" USING btree ("organization_id","user_id");
--> statement-breakpoint
ALTER TABLE "local_device" VALIDATE CONSTRAINT "local_device_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "local_device" VALIDATE CONSTRAINT "local_device_user_id_user_id_fk";
