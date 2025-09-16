ALTER TABLE `messages` ADD `prompt_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `completion_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `total_tokens` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `model` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `model_context_window` integer;