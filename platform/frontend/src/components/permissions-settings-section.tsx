// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import type { ReactNode } from "react";
import { AccessAudienceHeader } from "@/components/audience-chip";
import { SettingsSection } from "@/components/settings-section";

/**
 * The access block as one section of a settings surface. It is always the
 * plain full-width block: no title column and no card, because "Who can use
 * it" already names it.
 */
export function PermissionsSettingsSection({
  audience,
  lockedReason,
  children,
}: {
  /** What the grants add up to; null where there is no single object. */
  audience: ResourceVisibilityScope | null;
  /** Why the viewer cannot change the grants; null when they can. */
  lockedReason?: string | null;
  children: ReactNode;
}) {
  return (
    <SettingsSection>
      <div className="space-y-2">
        {audience && (
          <AccessAudienceHeader
            audience={audience}
            lockedReason={lockedReason}
          />
        )}
        {children}
      </div>
    </SettingsSection>
  );
}
