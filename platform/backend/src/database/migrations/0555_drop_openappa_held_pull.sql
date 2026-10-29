-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=OpenAPPA GitHub sync is beta and runs only on the dev cluster; old pods reading the held-pull columns during a rollout fail only their sync status read until they are replaced
ALTER TABLE "openappa_github_sync" DROP COLUMN "declarations_pending_publish";--> statement-breakpoint
ALTER TABLE "openappa_github_sync" DROP COLUMN "held_content";--> statement-breakpoint
ALTER TABLE "openappa_github_sync" DROP COLUMN "held_content_hash";--> statement-breakpoint
ALTER TABLE "openappa_github_sync" DROP COLUMN "held_source_commit";--> statement-breakpoint
ALTER TABLE "openappa_github_sync" DROP COLUMN "held_reasons";
