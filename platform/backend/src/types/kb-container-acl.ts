// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AclEntrySchema } from "./kb-document";

export const SelectKbContainerAclSchema = createSelectSchema(
  schema.kbContainerAclsTable,
  { acl: z.array(AclEntrySchema) },
);
export const InsertKbContainerAclSchema = createInsertSchema(
  schema.kbContainerAclsTable,
  { acl: z.array(AclEntrySchema) },
).omit({ id: true, createdAt: true, updatedAt: true, stale: true });

export type KbContainerAcl = z.infer<typeof SelectKbContainerAclSchema>;
export type InsertKbContainerAcl = z.infer<typeof InsertKbContainerAclSchema>;
