import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectSkillMarketplaceCredentialSchema = createSelectSchema(
  schema.skillMarketplaceCredentialsTable,
);

export type SkillMarketplaceCredential = z.infer<
  typeof SelectSkillMarketplaceCredentialSchema
>;
