import { z } from "zod";

export const ClaudeCodeAccountSchema = z.object({
  state: z.enum([
    "disconnected",
    "starting",
    "awaiting_code",
    "connecting",
    "connected",
    "failed",
    "expired",
  ]),
  requiresVaultReference: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  flowId: z.string().uuid().optional(),
  authorizationUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        ((url.hostname === "claude.com" &&
          url.pathname === "/cai/oauth/authorize") ||
          (url.hostname === "claude.ai" && url.pathname === "/oauth/authorize"))
      );
    })
    .optional(),
});

export type ClaudeCodeAccountStatus = z.infer<typeof ClaudeCodeAccountSchema>;

export const ClaudeCodeModelsSchema = z.object({
  models: z
    .array(
      z.object({
        value: z.string().min(1).max(256),
        displayName: z.string().min(1).max(256),
        description: z.string().max(2000),
      }),
    )
    .max(200),
});
