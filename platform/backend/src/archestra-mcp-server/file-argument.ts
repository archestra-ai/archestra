import { MCP_FILE_SCHEMA_KEYWORD } from "@archestra/shared";
import { z } from "zod";

/**
 * A built-in tool argument that takes a file under the MCP File Uploads
 * extension: a FileInput whose schema carries the `x-mcp-file` marker. Only
 * a caller that declared the extension is shown it, and the MCP gateway
 * hands the handler what arrived through `context.files`.
 */
export function fileInputArgument(
  settings: { accept?: string[]; maxSize?: number } = {},
) {
  return z
    .object({
      id: z.string().min(1).max(128),
      name: z.string().optional(),
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
      digest: z
        .object({ algorithm: z.literal("sha-256"), value: z.string() })
        .optional(),
      data: z.string().optional(),
    })
    .meta({ [MCP_FILE_SCHEMA_KEYWORD]: settings });
}
