import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import { SkillSandboxFileStorageProviderSchema } from "./skill-sandbox";

export const SelectPersistedFileSchema = createSelectSchema(schema.filesTable, {
  storageProvider: SkillSandboxFileStorageProviderSchema,
});

/** One persistent My Files row (the `files` table). */
export type PersistedFile = z.infer<typeof SelectPersistedFileSchema>;

/**
 * Minimal row shape the sandbox byte-storage router needs to read or delete a
 * stored blob. Both `skill_sandbox_files` and `files` rows satisfy it.
 */
export type StoredBlobRow = {
  id: string;
  data: Buffer | null;
  storageProvider: z.infer<typeof SkillSandboxFileStorageProviderSchema>;
  objectKey: string | null;
};
