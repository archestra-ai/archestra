// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import { ConnectorTypeSchema } from "./knowledge-connector";

// Brand `connectorType` with the ConnectorType enum (drizzle-zod does not carry
// a column's `$type<>` into the generated zod schema) so inserts match Drizzle's
// branded insert type.
const extendedFields = { connectorType: ConnectorTypeSchema };

export const SelectKbExternalUserGroupSchema = createSelectSchema(
  schema.kbExternalUserGroupsTable,
  extendedFields,
);
export const InsertKbExternalUserGroupSchema = createInsertSchema(
  schema.kbExternalUserGroupsTable,
  extendedFields,
).omit({ id: true, createdAt: true, updatedAt: true });

export type KbExternalUserGroup = z.infer<
  typeof SelectKbExternalUserGroupSchema
>;
export type InsertKbExternalUserGroup = z.infer<
  typeof InsertKbExternalUserGroupSchema
>;
