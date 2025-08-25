import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

import { mcpServersTable } from './mcpServer';

export const toolsTable = sqliteTable(
  'tools',
  {
    /**
     * Unique identifier combining mcp_server_id and tool_name
     * Format: {mcp_server_id}__{tool_name} (double underscore separator)
     */
    id: text().primaryKey(),

    /**
     * Foreign key reference to mcp_servers table
     */
    mcp_server_id: text()
      .notNull()
      .references(() => mcpServersTable.id, { onDelete: 'cascade' }),

    /**
     * Tool name from the MCP server
     */
    name: text().notNull(),

    /**
     * Tool description
     */
    description: text(),

    /**
     * Original tool schema from MCP server
     */
    input_schema: text({ mode: 'json' }),

    /**
     * Analysis results
     */
    is_read: integer({ mode: 'boolean' }),
    is_write: integer({ mode: 'boolean' }),
    idempotent: integer({ mode: 'boolean' }),
    reversible: integer({ mode: 'boolean' }),

    /**
     * Timestamp of when the analysis was performed
     */
    analyzed_at: text(),

    created_at: text()
      .notNull()
      .default(sql`(current_timestamp)`),

    updated_at: text()
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => ({
    mcpServerIdIdx: index('tools_mcp_server_id_idx').on(table.mcp_server_id),
  })
);

export const ToolAnalysisResultSchema = z.object({
  is_read: z.boolean(),
  is_write: z.boolean(),
  idempotent: z.boolean(),
  reversible: z.boolean(),
});

export const ToolSchema = createSelectSchema(toolsTable).extend({
  is_read: z.boolean().nullable(),
  is_write: z.boolean().nullable(),
  idempotent: z.boolean().nullable(),
  reversible: z.boolean().nullable(),
});

// Register schemas for OpenAPI generation
z.globalRegistry.add(ToolAnalysisResultSchema, { id: 'ToolAnalysisResult' });
z.globalRegistry.add(ToolSchema, { id: 'Tool' });

export type Tool = z.infer<typeof ToolSchema>;
export type ToolAnalysisResult = z.infer<typeof ToolAnalysisResultSchema>;
