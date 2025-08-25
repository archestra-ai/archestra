import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

export const McpClientInfoSchema = z.object({
  userAgent: z.string().optional(),
  clientName: z.string().optional(),
  clientVersion: z.string().optional(),
  clientPlatform: z.string().optional(),
});

export const mcpRequestLogs = sqliteTable(
  'mcp_request_logs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    requestId: text().unique().notNull(),
    sessionId: text(),
    mcpSessionId: text(),
    serverName: text().notNull(),
    clientInfo: text({ mode: 'json' }).$type<z.infer<typeof McpClientInfoSchema>>().notNull(),
    method: text(),
    requestHeaders: text({ mode: 'json' }).$type<Record<string, string>>().notNull(),
    requestBody: text(),
    responseBody: text(),
    responseHeaders: text({ mode: 'json' }).$type<Record<string, string>>().notNull(),
    statusCode: integer().notNull(),
    errorMessage: text(),
    durationMs: integer(),
    timestamp: text()
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    serverNameIdx: index('mcp_request_logs_server_name_idx').on(table.serverName),
    timestampIdx: index('mcp_request_logs_timestamp_idx').on(table.timestamp),
    mcpSessionIdIdx: index('mcp_request_logs_mcp_session_id_idx').on(table.mcpSessionId),
  })
);

/**
 * TODO: this is kinda a hack to get the outputted zod (and thereby openapi spec) to be 100% correct...
 */
export const SelectMcpRequestLogSchema = createSelectSchema(mcpRequestLogs).extend({
  clientInfo: McpClientInfoSchema,
});
