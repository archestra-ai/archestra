ALTER TABLE "knowledge_bases" DROP CONSTRAINT "knowledge_bases_secret_id_secret_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "config";--> statement-breakpoint
ALTER TABLE "knowledge_bases" DROP COLUMN "secret_id";