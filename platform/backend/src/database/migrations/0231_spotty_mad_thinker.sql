CREATE TABLE "chatops_external_id_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"adapter_id" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chatops_external_id_mapping" ADD CONSTRAINT "chatops_external_id_mapping_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_id_external_id_idx" ON "chatops_external_id_mapping" USING btree ("adapter_id","external_id");