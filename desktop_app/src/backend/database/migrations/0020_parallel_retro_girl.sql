ALTER TABLE `chats` ADD `total_prompt_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `chats` ADD `total_completion_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `chats` ADD `total_tokens` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `chats` ADD `last_model` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `last_context_window` integer;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `prompt_tokens`;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `completion_tokens`;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `total_tokens`;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `model_context_window`;