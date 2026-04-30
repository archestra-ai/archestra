CREATE TABLE "k8s_cluster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kubeconfig" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "k8s_namespace" text;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "k8s_cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "k8s_cluster" ADD CONSTRAINT "k8s_cluster_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_k8s_cluster_id_k8s_cluster_id_fk" FOREIGN KEY ("k8s_cluster_id") REFERENCES "public"."k8s_cluster"("id") ON DELETE set null ON UPDATE no action;