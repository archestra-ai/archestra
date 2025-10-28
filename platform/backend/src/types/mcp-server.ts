import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
  users: z.array(z.string()).optional(),
  userDetails: z
    .array(
      z.object({
        userId: z.string(),
        email: z.string(),
        createdAt: z.coerce.date(),
      }),
    )
    .optional(),
  teamDetails: z
    .array(
      z.object({
        teamId: z.string(),
        name: z.string(),
        createdAt: z.coerce.date(),
      }),
    )
    .optional(),
});
export const InsertMcpServerSchema = createInsertSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
  userId: z.string().optional(), // For personal auth
});
export const UpdateMcpServerSchema = createUpdateSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
});

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
