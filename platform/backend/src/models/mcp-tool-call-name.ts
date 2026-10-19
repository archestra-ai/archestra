import { sql } from "drizzle-orm";
import { schema } from "@/database";

const calls = schema.mcpToolCallsTable;

/**
 * The called tool's name. Rows written before the plaintext column existed fall
 * back to the logged call JSON, which is unreadable (and so null) when the
 * content is encrypted; encrypted-chat rows are never read. Never read
 * `tool_call->>'name'` directly: under at-rest encryption it is always null.
 */
export const MCP_TOOL_CALL_TOOL_NAME = sql<
  string | null
>`COALESCE(${calls.toolName}, CASE WHEN ${calls.encryptedChatConversationId} IS NULL AND jsonb_typeof(${calls.toolCall}) = 'object' THEN ${calls.toolCall}->>'name' END)`;
