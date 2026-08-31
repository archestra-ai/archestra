import { CreatedByNullableSchema } from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Who an uploaded document is visible to once indexed.
 *
 * Deliberately its own enum rather than reusing `KnowledgeSourceVisibility`:
 * a connector cannot be "private to one person", and these values map straight
 * onto the direct ACL tokens a document carries (`org:*`, `team:<id>`,
 * `user_email:<email>`), with no auto-sync mode.
 */
export const KnowledgeFileVisibilitySchema = z.enum([
  "org-wide",
  "team-scoped",
  "private",
]);
export type KnowledgeFileVisibility = z.infer<
  typeof KnowledgeFileVisibilitySchema
>;

export const SelectKbDirectorySchema = createSelectSchema(
  schema.kbDirectoriesTable,
);
export type KbDirectory = z.infer<typeof SelectKbDirectorySchema>;

/**
 * Directories and files both replace their raw creator column with the resolved
 * identity the shared "Created by" cell renders. `createdBy.id` still answers
 * "is this mine", so nothing needed the bare id that used to sit here.
 */
const DirectoryResponseCreatorSchema = SelectKbDirectorySchema.omit({
  createdBy: true,
}).extend({ createdBy: CreatedByNullableSchema });

/** A directory plus the teams it is shared with, as the API returns it. */
export const KbDirectoryWithTeamsSchema = DirectoryResponseCreatorSchema.extend(
  {
    teamIds: z.array(z.string()),
    fileCount: z.number(),
  },
);
export type KbDirectoryWithTeams = z.infer<typeof KbDirectoryWithTeamsSchema>;

/**
 * A repository file as the API returns it — never including `data`, which is
 * served only by the content route.
 */
export const KbFileSchema = createSelectSchema(schema.kbFilesTable)
  .omit({
    data: true,
    objectKey: true,
    storageProvider: true,
    uploadedBy: true,
  })
  .extend({
    /** The uploader, resolved: for a file, creating it *is* uploading it. */
    createdBy: CreatedByNullableSchema,
    /** Knowledge bases this file is currently indexed into. */
    knowledgeBases: z.array(z.object({ id: z.string(), name: z.string() })),
    /** Teams a `team-scoped` file is shared with, so the UI can name them. */
    teamIds: z.array(z.string()),
  });
export type KbFile = z.infer<typeof KbFileSchema>;
