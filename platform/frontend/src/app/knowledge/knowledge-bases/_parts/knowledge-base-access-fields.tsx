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
  standalone,
}: {
  form: UseFormReturn<KnowledgeBaseFormValues>;
  standalone?: boolean;
}) {
  return (
    <InitialResourcePermissions
      resource="knowledgeBase"
      standalone={standalone}
      grants={form.watch("initialGrants")}
      onChange={(grants) =>
        form.setValue("initialGrants", grants, { shouldDirty: true })
      }
    />
  );
}
