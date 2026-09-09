import { z } from "zod";

export const AgentWorkspaceFileRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("read"), path: relativePath() }),
    z.object({
      operation: z.literal("write"),
      path: relativePath(),
      content_base64: z
        .string()
        .max(5_592_408)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        ),
      overwrite: z.boolean().default(false),
    }),
  ],
);

export const AgentWorkspaceFileResultSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  content_base64: z.string().optional(),
});

export type AgentWorkspaceFileRequest = z.infer<
  typeof AgentWorkspaceFileRequestSchema
>;
export type AgentWorkspaceFileResult = z.infer<
  typeof AgentWorkspaceFileResultSchema
>;

function relativePath() {
  return z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        !value.includes("\0") &&
        value
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
      "Use a workspace-relative path without traversal",
    );
}
