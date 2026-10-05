// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ReactNode } from "react";
import { SettingsSection } from "@/components/settings-section";

export function permissionsSettingsDescription(resourceName: string) {
  return `Choose who can access this ${resourceName} and what they can do. Organization grants also apply.`;
}

/** Shared presentation for draft grants and an existing resource's policy. */
export function PermissionsSettingsSection({
  resourceName,
  directCount,
  inheritedCount,
  action,
  children,
}: {
  resourceName: string;
  directCount: number;
  inheritedCount: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const summary = [
    `${directCount} added ${directCount === 1 ? "grant" : "grants"}`,
    ...(inheritedCount > 0
      ? [
          `${inheritedCount} organization ${inheritedCount === 1 ? "grant" : "grants"}`,
        ]
      : []),
  ].join(" · ");

  return (
    <SettingsSection
      title="Permissions"
      description={permissionsSettingsDescription(resourceName)}
    >
      <div className="rounded-md border px-3">
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="min-w-0 text-sm text-muted-foreground">
            {summary}
          </span>
          {action}
        </div>
        {children}
      </div>
    </SettingsSection>
  );
}
