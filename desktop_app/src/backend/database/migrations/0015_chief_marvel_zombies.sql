ALTER TABLE `user` ADD `unique_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `user_uniqueId_unique` ON `user` (`unique_id`);