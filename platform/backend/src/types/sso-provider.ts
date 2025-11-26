import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectSsoProviderSchema = createSelectSchema(
  schema.ssoProvidersTable,
);
export const InsertSsoProviderSchema = createInsertSchema(
  schema.ssoProvidersTable,
);
export const UpdateSsoProviderSchema = createUpdateSchema(
  schema.ssoProvidersTable,
);

export type SsoProvider = z.infer<typeof SelectSsoProviderSchema>;
export type InsertSsoProvider = z.infer<typeof InsertSsoProviderSchema>;
export type UpdateSsoProvider = z.infer<typeof UpdateSsoProviderSchema>;
