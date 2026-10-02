-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Cosmetic rename of the locked-chat columns to encrypted-chat. Catalog-only RENAMEs (no rewrite, no indexed column); the brief rolling-deploy window is accepted instead of an expand/contract cycle spread over two releases.
--
-- Renames the locked-chat columns to match the feature's new name, the same
-- way 0417 renamed them from "incognito". Each statement is a catalog-only
-- RENAME: no table rewrite, no data movement, and no index rebuild (none of
-- these columns is indexed). Renaming rather than add+drop is essential for
-- "locked_chat_escrow" in particular — it holds the wrapped conversation keys,
-- the only break-glass recovery path for encrypted chats.
ALTER TABLE "conversations" RENAME COLUMN "locked_chat" TO "encrypted_chat";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "locked_chat_dek_fingerprint" TO "encrypted_chat_dek_fingerprint";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "locked_chat_escrow" TO "encrypted_chat_escrow";--> statement-breakpoint
ALTER TABLE "conversation_attachments" RENAME COLUMN "locked_chat" TO "encrypted_chat";--> statement-breakpoint
ALTER TABLE "interactions" RENAME COLUMN "locked_chat_conversation_id" TO "encrypted_chat_conversation_id";--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" RENAME COLUMN "locked_chat_conversation_id" TO "encrypted_chat_conversation_id";
