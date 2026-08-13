// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { kbExternalGroupsTable } from "@/database/schemas";
import { ConnectorTypeSchema } from "./knowledge-connector";

const extendedFields = { connectorType: ConnectorTypeSchema };

export const SelectKbExternalGroupSchema = createSelectSchema(
  kbExternalGroupsTable,
  extendedFields,
);
export const InsertKbExternalGroupSchema = createInsertSchema(
  kbExternalGroupsTable,
  extendedFields,
).omit({ id: true, createdAt: true, updatedAt: true });

export type KbExternalGroup = z.infer<typeof SelectKbExternalGroupSchema>;
export type InsertKbExternalGroup = z.infer<typeof InsertKbExternalGroupSchema>;
