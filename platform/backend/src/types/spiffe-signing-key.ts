// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database/schema";

const SelectSpiffeSigningKeySchema = createSelectSchema(
  schema.spiffeSigningKeysTable,
);
const InsertSpiffeSigningKeySchema = createInsertSchema(
  schema.spiffeSigningKeysTable,
);

export type SpiffeSigningKey = z.infer<typeof SelectSpiffeSigningKeySchema>;
export type InsertSpiffeSigningKey = z.infer<
  typeof InsertSpiffeSigningKeySchema
>;
