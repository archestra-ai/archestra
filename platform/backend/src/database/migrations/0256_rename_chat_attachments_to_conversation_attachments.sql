ALTER TABLE "chat_attachments" RENAME TO "conversation_attachments";--> statement-breakpoint
ALTER INDEX "chat_attachments_conversation_id_idx" RENAME TO "conversation_attachments_conversation_id_idx";--> statement-breakpoint
ALTER INDEX "chat_attachments_org_created_at_idx" RENAME TO "conversation_attachments_org_created_at_idx";--> statement-breakpoint
ALTER INDEX "chat_attachments_conversation_id_content_hash_live_uidx" RENAME TO "conversation_attachments_conversation_id_content_hash_live_uidx";--> statement-breakpoint
ALTER TABLE "conversation_attachments" RENAME CONSTRAINT "chat_attachments_pkey" TO "conversation_attachments_pkey";--> statement-breakpoint
ALTER TABLE "conversation_attachments" RENAME CONSTRAINT "chat_attachments_conversation_id_conversations_id_fk" TO "conversation_attachments_conversation_id_conversations_id_fk";
