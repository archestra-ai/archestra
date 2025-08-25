CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`mcp_server_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`input_schema` text,
	`is_read` integer,
	`is_write` integer,
	`idempotent` integer,
	`reversible` integer,
	`analyzed_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`mcp_server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tools_mcp_server_id_idx` ON `tools` (`mcp_server_id`);