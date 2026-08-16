-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Cosmetic rename of the locked-chat columns. Catalog-only RENAMEs (no rewrite, no indexed column); the brief rolling-deploy window is accepted instead of an expand/contract cycle spread over two releases.
--
-- Renames the locked-chat columns to match the feature's name. The linter
-- flags renames because they are not rollout-safe: during a rolling deploy,
-- pods still running the previous image select the old column names and fail
-- until they are replaced. That window is accepted here rather than paid for
-- with an expand/contract cycle (add, dual-write, backfill, drop over two
-- releases), because it would spread a cosmetic rename across two releases
-- and leave dual-spelling reads in the code in between.
--
-- Each statement is a catalog-only RENAME: no table rewrite, no data movement,
-- and no index rebuild (none of these columns is indexed). Renaming rather
-- than add+drop is essential for "incognito_escrow" in particular — it holds
-- the wrapped conversation keys, which are the only break-glass recovery path
-- for locked chats, so dropping it would destroy unrecoverable data.
ALTER TABLE "conversations" RENAME COLUMN "incognito" TO "locked_chat";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "incognito_dek_fingerprint" TO "locked_chat_dek_fingerprint";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "incognito_escrow" TO "locked_chat_escrow";--> statement-breakpoint
ALTER TABLE "interactions" RENAME COLUMN "incognito_conversation_id" TO "locked_chat_conversation_id";--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" RENAME COLUMN "incognito_conversation_id" TO "locked_chat_conversation_id";
