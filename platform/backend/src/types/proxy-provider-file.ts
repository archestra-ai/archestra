import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import proxyProviderFilesTable from "@/database/schemas/proxy-provider-file";

export const ProxyProviderFileSchema = createSelectSchema(
  proxyProviderFilesTable,
);
export const InsertProxyProviderFileSchema = createInsertSchema(
  proxyProviderFilesTable,
);
export type ProxyProviderFile = z.infer<typeof ProxyProviderFileSchema>;
export type InsertProxyProviderFile = z.infer<
  typeof InsertProxyProviderFileSchema
>;

export const ProviderFileResponseSchema = z.object({
  id: z.string(),
  object: z.literal("file"),
  bytes: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  filename: z.string(),
  purpose: z.literal("user_data"),
  expires_at: z.number().int().positive().optional(),
  status: z
    .enum([
      "uploaded",
      "processed",
      "error",
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ])
    .optional(),
});

export type ProviderFileResponse = z.infer<typeof ProviderFileResponseSchema>;
