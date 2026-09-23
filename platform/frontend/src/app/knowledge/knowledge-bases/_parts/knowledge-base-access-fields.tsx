// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { UseFormReturn } from "react-hook-form";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";

export interface KnowledgeBaseFormValues {
  name: string;
  description: string;
  initialGrants: InitialPermissionGrant[];
}

export function KnowledgeBaseAccessFields({
  form,
}: {
  form: UseFormReturn<KnowledgeBaseFormValues>;
}) {
  return (
    <InitialResourcePermissions
      resource="knowledgeBase"
      authorless
      grants={form.watch("initialGrants")}
      onChange={(grants) =>
        form.setValue("initialGrants", grants, { shouldDirty: true })
      }
    />
  );
}
