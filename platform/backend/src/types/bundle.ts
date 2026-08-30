import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const BundleLocalMcpServerSchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "MCP server names may contain only letters, numbers, hyphens, and underscores",
    ),
  description: z.string().trim().max(500).default(""),
  command: z.string().trim().min(1).max(1_000),
  args: z.array(z.string().max(1_000)).max(100).default([]),
  envVarNames: z
    .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
    .max(50)
    .default([]),
  optional: z.boolean().default(true),
});
export type BundleLocalMcpServer = z.infer<typeof BundleLocalMcpServerSchema>;

const BundleLocalMcpServerInputSchema = BundleLocalMcpServerSchema.extend({
  id: z.string().uuid().optional(),
});

const BundleLocalMcpServersInputSchema = z
  .array(BundleLocalMcpServerInputSchema)
  .max(50)
  .superRefine((servers, ctx) => {
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const [index, server] of servers.entries()) {
      const normalizedName = server.name.toLowerCase();
      if (names.has(normalizedName)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: "MCP server names must be unique within a bundle",
        });
      }
      names.add(normalizedName);
      if (server.id) {
        if (ids.has(server.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: "MCP server IDs must be unique within a bundle",
          });
        }
        ids.add(server.id);
      }
    }
  });

export const SelectBundleSchema = createSelectSchema(schema.bundlesTable, {
  localMcpServers: BundleLocalMcpServerSchema.array(),
});

export const BundleSchema = SelectBundleSchema.extend({
  skillIds: z.array(z.string().uuid()),
  pluginIds: z.array(z.string().uuid()),
});

export const CreateBundleSchema = createInsertSchema(schema.bundlesTable)
  .pick({ name: true, description: true, mcpGatewayId: true })
  .extend({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).default(""),
    mcpGatewayId: z.string().uuid().nullable().default(null),
    skillIds: z.array(z.string().uuid()).max(500).default([]),
    pluginIds: z.array(z.string().uuid()).max(50).default([]),
    localMcpServers: BundleLocalMcpServersInputSchema.default([]),
  });

export const UpdateBundleSchema = createUpdateSchema(schema.bundlesTable)
  .pick({ name: true, description: true, mcpGatewayId: true })
  .extend({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1_000).optional(),
    mcpGatewayId: z.string().uuid().nullable().optional(),
    skillIds: z.array(z.string().uuid()).max(500).optional(),
    pluginIds: z.array(z.string().uuid()).max(50).optional(),
    localMcpServers: BundleLocalMcpServersInputSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export type Bundle = z.infer<typeof BundleSchema>;
export type CreateBundle = z.infer<typeof CreateBundleSchema>;
export type UpdateBundle = z.infer<typeof UpdateBundleSchema>;
