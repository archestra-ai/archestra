import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database/schema";

export const SelectSkillMarketplaceRepoSchema = createSelectSchema(
  schema.skillMarketplaceReposTable,
);

export type SkillMarketplaceRepo = z.infer<
  typeof SelectSkillMarketplaceRepoSchema
>;
