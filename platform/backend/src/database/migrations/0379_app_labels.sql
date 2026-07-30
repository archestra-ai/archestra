-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=brand-new table (app_labels) has no existing rows, so its FK constraints cannot fail on any data; CASCADE deletes are intentional (a label row is meaningless without its app/key/value).
CREATE TABLE "app_labels" (
	"app_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_labels_app_id_key_id_pk" PRIMARY KEY("app_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "app_labels" ADD CONSTRAINT "app_labels_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_labels" ADD CONSTRAINT "app_labels_key_id_label_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."label_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_labels" ADD CONSTRAINT "app_labels_value_id_label_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."label_values"("id") ON DELETE cascade ON UPDATE no action;