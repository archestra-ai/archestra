import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database/schema";

export const SelectSkillMarketplaceCredentialSchema = createSelectSchema(
  schema.skillMarketplaceCredentialsTable,
);

export type SkillMarketplaceCredential = z.infer<
  typeof SelectSkillMarketplaceCredentialSchema
>;
