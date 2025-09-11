ALTER TABLE `user` ADD `unique_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `collect_analytics_data` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `user_uniqueId_unique` ON `user` (`unique_id`);