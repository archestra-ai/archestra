CREATE TABLE "cluster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"namespace" text,
	"kubeconfig_secret_id" uuid,
	"load_from_cluster" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_personal_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "cluster" ADD CONSTRAINT "cluster_kubeconfig_secret_id_secret_id_fk" FOREIGN KEY ("kubeconfig_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_single_default_idx" ON "cluster" USING btree ("is_default") WHERE "cluster"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_single_personal_default_idx" ON "cluster" USING btree ("is_personal_default") WHERE "cluster"."is_personal_default" = true;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE set null ON UPDATE no action;