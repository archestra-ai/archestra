import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectSiteAnnouncementSchema = createSelectSchema(
  schema.siteAnnouncementsTable,
);

export const UpsertSiteAnnouncementSchema = z.object({
  markdown: z.string().trim().min(1).max(2000),
  expiresAt: z.coerce.date().nullable(),
});

export type SiteAnnouncement = z.infer<typeof SelectSiteAnnouncementSchema>;
export type UpsertSiteAnnouncement = z.infer<
  typeof UpsertSiteAnnouncementSchema
>;
