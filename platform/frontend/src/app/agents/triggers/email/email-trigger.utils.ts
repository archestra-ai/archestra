import {
  DOMAIN_VALIDATION_REGEX,
  type IncomingEmailSecurityMode,
  IncomingEmailSecurityModeSchema,
  MAX_DOMAIN_LENGTH,
} from "@shared";
import { z } from "zod";

export const AgentEmailSettingsFormSchema = z
  .object({
    incomingEmailEnabled: z.boolean(),
    incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
    incomingEmailAllowedDomain: z.string(),
  })
  .superRefine((data, ctx) => {
    if (
      !data.incomingEmailEnabled ||
      data.incomingEmailSecurityMode !== "internal"
    ) {
      return;
    }

    const domain = data.incomingEmailAllowedDomain.trim();

    if (!domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Allowed domain is required for internal security mode",
        path: ["incomingEmailAllowedDomain"],
      });
      return;
    }

    if (domain.length > MAX_DOMAIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Domain must not exceed ${MAX_DOMAIN_LENGTH} characters`,
        path: ["incomingEmailAllowedDomain"],
      });
      return;
    }

    if (!DOMAIN_VALIDATION_REGEX.test(domain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Please enter a valid domain (for example, company.com)",
        path: ["incomingEmailAllowedDomain"],
      });
    }
  });

export type AgentEmailSettingsFormValues = z.infer<
  typeof AgentEmailSettingsFormSchema
>;

export function formatIncomingEmailSecurityMode(
  mode: IncomingEmailSecurityMode,
): string {
  if (mode === "private") return "Private";
  if (mode === "internal") return "Internal";
  return "Public";
}

export function describeIncomingEmailSecurityMode(
  mode: IncomingEmailSecurityMode,
  allowedDomain?: string | null,
  appName = "platform",
): string {
  if (mode === "private") {
    return `Only matching ${appName} users with access to this agent can email it.`;
  }
  if (mode === "internal") {
    return allowedDomain
      ? `Only senders from @${allowedDomain} can email this agent.`
      : "Only senders from an approved email domain can email this agent.";
  }
  return "Any sender can email this agent.";
}

export function getIncomingEmailWebhookUrl(publicBaseUrl: string): string {
  if (!publicBaseUrl) {
    return "/api/webhooks/incoming-email";
  }

  return `${publicBaseUrl.replace(/\/$/, "")}/api/webhooks/incoming-email`;
}

export function formatIncomingEmailExpiry(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export function getIncomingEmailTimeUntilExpiry(
  dateString: string,
  now = new Date(),
): string {
  const expiry = new Date(dateString);
  const diffMs = expiry.getTime() - now.getTime();

  if (diffMs <= 0) return "Expired";

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days > 0) {
    return `${days}d ${remainingHours}h remaining`;
  }

  return `${hours}h remaining`;
}
