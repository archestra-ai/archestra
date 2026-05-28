ALTER TABLE IF EXISTS "chat_attachments" RENAME TO "conversation_attachments";--> statement-breakpoint
ALTER INDEX IF EXISTS "chat_attachments_conversation_id_idx" RENAME TO "conversation_attachments_conversation_id_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "chat_attachments_org_created_at_idx" RENAME TO "conversation_attachments_org_created_at_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "chat_attachments_conversation_id_content_hash_live_uidx" RENAME TO "conversation_attachments_conversation_id_content_hash_live_uidx";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_attachments_pkey') THEN
    ALTER TABLE "conversation_attachments" RENAME CONSTRAINT "chat_attachments_pkey" TO "conversation_attachments_pkey";
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_attachments_conversation_id_conversations_id_fk') THEN
    ALTER TABLE "conversation_attachments" RENAME CONSTRAINT "chat_attachments_conversation_id_conversations_id_fk" TO "conversation_attachments_conversation_id_conversations_id_fk";
  END IF;
END $$;
