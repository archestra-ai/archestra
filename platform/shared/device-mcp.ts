import { z } from "zod";

// Reviewed launch instructions only. Tool calls carry MCP arguments, never a
// command, executable path, working directory, or environment override.
const DeviceMcpLaunchSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(
        (value) => !/[\r\n\0]/.test(value),
        "Command must be an executable, not a shell script",
      ),
    args: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0")),
      )
      .max(128),
  })
  .strict();

export const DeviceMcpConfigSchema = z
  .object({
    protocolVersion: z.literal(1),
    version: z.string().trim().min(1).max(64),
    platforms: z
      .object({
        darwin: DeviceMcpLaunchSchema,
        win32: DeviceMcpLaunchSchema,
      })
      .strict(),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
            description: z.string().max(8192).optional(),
            inputSchema: z
              .object({ type: z.literal("object") })
              .catchall(z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(1024)
      .refine(
        (tools) =>
          new Set(tools.map((tool) => tool.name.toLowerCase())).size ===
          tools.length,
        "Tool names must be unique",
      ),
  })
  .strict();

export type DeviceMcpConfig = z.infer<typeof DeviceMcpConfigSchema>;
