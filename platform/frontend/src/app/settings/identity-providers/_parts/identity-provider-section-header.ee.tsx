// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ReactNode } from "react";

export function IdentityProviderSectionHeader({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {children}
      </p>
    </div>
  );
}
