import { z } from "zod";

export const JiraIngressModeSchema = z.enum(["hmac", "automation", "poll"]);

export const JiraCommentEventSchema = z.object({
  webhookEvent: z.enum(["comment_created", "comment_updated"]),
  issue: z.object({ id: z.string().regex(/^\d+$/).max(32) }),
  comment: z.object({
    id: z.string().regex(/^\d+$/).max(32),
    updated: z
      .string()
      .max(64)
      .refine((value) => Number.isFinite(Date.parse(value))),
  }),
});

const JiraBotConfigSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  accountId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  email: z.string().email().max(320),
  apiToken: z.string().min(1).max(4096),
  cloudId: z.string().uuid().optional(),
  enabled: z.boolean(),
  fallbackServiceAccountId: z.string().uuid().optional(),
  fallbackReviewerUserId: z.string().min(1).max(256).optional(),
});
export type JiraBotConfig = z.infer<typeof JiraBotConfigSchema>;

export const JiraDbConfigSchema = z
  .object({
    id: z.string().uuid(),
    organizationId: z.string().min(1),
    enabled: z.boolean(),
    siteUrl: z.string(),
    ingressMode: JiraIngressModeSchema,
    webhookSecret: z.string().max(4096),
    bots: z.array(JiraBotConfigSchema),
    pollSince: z.string().datetime().optional(),
    pollStartedAt: z.string().datetime().optional(),
  })
  .refine(
    (value) => value.ingressMode === "poll" || value.webhookSecret.length >= 16,
    {
      message: "Webhook delivery requires a secret with at least 16 characters",
      path: ["webhookSecret"],
    },
  );
export type JiraDbConfig = z.infer<typeof JiraDbConfigSchema>;

export const JiraBotViewSchema = JiraBotConfigSchema.omit({
  apiToken: true,
  fallbackServiceAccountId: true,
  fallbackReviewerUserId: true,
}).extend({
  hasApiToken: z.boolean(),
  fallbackServiceAccountId: z.string().uuid().nullable(),
  fallbackReviewerUserId: z.string().nullable(),
});

export const JiraChatOpsConfigViewSchema = z.object({
  id: z.string().uuid().nullable(),
  enabled: z.boolean(),
  siteUrl: z.string(),
  ingressMode: JiraIngressModeSchema,
  hasWebhookSecret: z.boolean(),
  webhookUrl: z.string().nullable(),
  bots: z.array(JiraBotViewSchema),
  pollingSupported: z.literal(true),
});

export const JiraProjectSchema = z.object({
  id: z.string().min(1).max(256),
  key: z.string().min(1).max(256),
  name: z.string().min(1).max(512),
});

/** The REST host is selected by an administrator, never by an event payload. */
export function normalizeJiraSiteUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !["/", "/jira", "/jira/"].includes(url.pathname) ||
    /:\d+(?:\/|$)/.test(value.replace(/^https:\/\//i, ""))
  ) {
    throw new Error(
      "Use an HTTPS Jira Cloud site URL such as https://example.atlassian.net",
    );
  }
  return url.origin;
}
