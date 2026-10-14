// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";
import { ResourceListActions } from "@/components/resource-list-actions";
export function OAuthClientPermissions() {
  return <ResourceListActions resource="oauthClient" label="Permissions" />;
}
