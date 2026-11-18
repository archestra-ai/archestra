CREATE TABLE "environment_cluster_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_cluster_writes" ADD CONSTRAINT "environment_cluster_writes_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "environment_cluster_writes" VALIDATE CONSTRAINT "environment_cluster_writes_environment_id_environments_id_fk";--> statement-breakpoint
CREATE INDEX "environment_cluster_writes_environment_id_idx" ON "environment_cluster_writes" USING btree ("environment_id");