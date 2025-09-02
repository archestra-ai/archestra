-- Drop the old memories table
DROP TABLE IF EXISTS `memories`;

-- Create new memory_entries table with name-value structure
CREATE TABLE `memory_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

-- Create unique index for user_id and name combination
CREATE UNIQUE INDEX `user_name_idx` ON `memory_entries` (`user_id`, `name`);