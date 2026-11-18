import { z } from "zod";

export const SiteRoleSchema = z.enum(["primary", "secondary"]);
export type SiteRole = z.infer<typeof SiteRoleSchema>;

/** What a site can reach, detected from its own environment on startup. */
export const SiteCapabilitiesSchema = z.object({
  /** Keyless providers (cloud identity, no stored key) this site serves. */
  keylessProviders: z.array(z.string()),
});
export type SiteCapabilities = z.infer<typeof SiteCapabilitiesSchema>;

export const SiteSchema = z.object({
  name: z.string(),
  role: SiteRoleSchema,
  internalUrl: z.string().nullable(),
  version: z.string(),
  capabilities: SiteCapabilitiesSchema,
  draining: z.boolean(),
  startedAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
});
export type Site = z.infer<typeof SiteSchema>;
