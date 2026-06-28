CREATE TABLE "virtual_api_key_llm_proxy" (
	"virtual_api_key_id" uuid NOT NULL,
	"llm_proxy_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_api_key_llm_proxy_virtual_api_key_id_llm_proxy_id_pk" PRIMARY KEY("virtual_api_key_id","llm_proxy_id")
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "passthrough_virtual_key_id" uuid;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "key_type" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_api_key_llm_proxy" ADD CONSTRAINT "virtual_api_key_llm_proxy_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "virtual_api_key_llm_proxy" ADD CONSTRAINT "virtual_api_key_llm_proxy_llm_proxy_id_agents_id_fk" FOREIGN KEY ("llm_proxy_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_llm_proxy_llm_proxy_id" ON "virtual_api_key_llm_proxy" USING btree ("llm_proxy_id");--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_passthrough_virtual_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("passthrough_virtual_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE set null ON UPDATE no action NOT VALID;