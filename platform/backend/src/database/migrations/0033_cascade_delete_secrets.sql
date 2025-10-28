-- Drop the existing foreign key constraint
ALTER TABLE "mcp_server" DROP CONSTRAINT "mcp_server_secret_id_secret_id_fk";
--> statement-breakpoint
-- Add the foreign key constraint with cascade delete
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;
