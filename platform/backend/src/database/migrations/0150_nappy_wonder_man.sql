CREATE TABLE "mcp_catalog_labels" (
	"catalog_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_catalog_labels_catalog_id_key_id_pk" PRIMARY KEY("catalog_id","key_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_catalog_labels" ADD CONSTRAINT "mcp_catalog_labels_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_catalog_labels" ADD CONSTRAINT "mcp_catalog_labels_key_id_label_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."label_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_catalog_labels" ADD CONSTRAINT "mcp_catalog_labels_value_id_label_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."label_values"("id") ON DELETE cascade ON UPDATE no action;