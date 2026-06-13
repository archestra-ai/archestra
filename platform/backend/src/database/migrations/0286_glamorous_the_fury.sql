-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=brand-new table (team_labels) has no existing rows, so its FK constraints cannot fail on any data; CASCADE deletes are intentional (a label row is meaningless without its team/key/value).
CREATE TABLE "team_labels" (
	"team_id" text NOT NULL,
	"key_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_labels_team_id_key_id_pk" PRIMARY KEY("team_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "team_labels" ADD CONSTRAINT "team_labels_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_labels" ADD CONSTRAINT "team_labels_key_id_label_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."label_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_labels" ADD CONSTRAINT "team_labels_value_id_label_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."label_values"("id") ON DELETE cascade ON UPDATE no action;