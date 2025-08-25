CREATE INDEX `chats_created_at_idx` ON `chats` (`created_at`);--> statement-breakpoint
CREATE INDEX `mcp_request_logs_server_name_idx` ON `mcp_request_logs` (`server_name`);--> statement-breakpoint
CREATE INDEX `mcp_request_logs_timestamp_idx` ON `mcp_request_logs` (`timestamp`);--> statement-breakpoint
CREATE INDEX `mcp_request_logs_mcp_session_id_idx` ON `mcp_request_logs` (`mcp_session_id`);--> statement-breakpoint
CREATE INDEX `messages_chat_id_idx` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `messages_chat_id_created_at_idx` ON `messages` (`chat_id`,`created_at`);