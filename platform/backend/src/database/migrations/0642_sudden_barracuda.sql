ALTER TABLE "environments" ADD COLUMN "kubeconfig_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "kubeconfig_server" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "kubeconfig_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "agent_runtime_platform_base_url" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "deleting_at" timestamp;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_kubeconfig_secret_id_secret_id_fk" FOREIGN KEY ("kubeconfig_secret_id") REFERENCES "public"."secret"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "environments" VALIDATE CONSTRAINT "environments_kubeconfig_secret_id_secret_id_fk";