import { createPaginatedResponseSchema } from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SkillSandboxFileStorageProviderSchema } from "./skill-sandbox";

export const SelectPublicFileLinkSchema = createSelectSchema(
  schema.publicFileLinksTable,
  { storageProvider: SkillSandboxFileStorageProviderSchema },
);

export type PublicFileLink = z.infer<typeof SelectPublicFileLinkSchema>;

/**
 * One row of a shared-files list: the link plus the names needed to recognise
 * it (who asked, which agent) and the full public URL. Where the bytes are
 * stored stays internal.
 */
export const PublicFileLinkListItemSchema = SelectPublicFileLinkSchema.omit({
  data: true,
  storageProvider: true,
  objectKey: true,
}).extend({
  url: z.string(),
  createdBy: z
    .object({ id: z.string(), name: z.string(), email: z.string() })
    .nullable(),
  agent: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export type PublicFileLinkListItem = z.infer<
  typeof PublicFileLinkListItemSchema
>;

export const PublicFileLinkListResponseSchema = createPaginatedResponseSchema(
  PublicFileLinkListItemSchema,
);
