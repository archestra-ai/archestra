import { createPaginatedResponseSchema } from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectPublicFileLinkSchema = createSelectSchema(
  schema.publicFileLinksTable,
);

export type PublicFileLink = z.infer<typeof SelectPublicFileLinkSchema>;

/**
 * One row of the admin shared-files list: the link plus the names an admin
 * needs to recognise it (who asked, which agent) and the full public URL.
 */
export const PublicFileLinkListItemSchema = SelectPublicFileLinkSchema.extend({
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
