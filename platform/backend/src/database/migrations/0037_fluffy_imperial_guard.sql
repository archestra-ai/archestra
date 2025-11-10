CREATE TABLE "agent_labels" (
	"agent_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"value_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_labels_agent_id_key_id_pk" PRIMARY KEY("agent_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "label_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "label_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "label_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "label_values_value_unique" UNIQUE("value")
);
--> statement-breakpoint
ALTER TABLE "agent_labels" ADD CONSTRAINT "agent_labels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_labels" ADD CONSTRAINT "agent_labels_key_id_label_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."label_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_labels" ADD CONSTRAINT "agent_labels_value_id_label_values_id_fk" FOREIGN KEY ("value_id") REFERENCES "public"."label_values"("id") ON DELETE cascade ON UPDATE no action;