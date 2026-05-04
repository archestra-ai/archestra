ALTER TABLE "mcp_server" DROP CONSTRAINT "mcp_server_cluster_id_cluster_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE restrict ON UPDATE no action;