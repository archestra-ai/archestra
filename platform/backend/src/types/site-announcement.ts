import { z } from "zod";

export const SiteAnnouncementSchema = z.object({
  content: z.string(),
  expiresAt: z.string().datetime().nullable(),
});

export const SiteAnnouncementResponseSchema = z.object({
  announcement: SiteAnnouncementSchema.nullable(),
});

export const SiteAnnouncementPayloadSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  expiresAt: z.string().datetime().nullable(),
});

export type SiteAnnouncement = z.infer<typeof SiteAnnouncementSchema>;
