// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type * as React from "react";
import { cn } from "@/lib/utils";

interface DisabledEnterpriseSectionProps {
  /**
   * When true, dims and disables the wrapped UI (pointer events off,
   * opacity reduced, fieldset disabled so form controls won't submit).
   */
  disabled: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps an enterprise UI surface that the spec wants visible-but-inert when
 * the enterprise license is not effective. Uses `<fieldset disabled>` so
 * form controls truly stop submitting, plus opacity + pointer-events for
 * the visual cue.
 */
export function DisabledEnterpriseSection({
  disabled,
  children,
  className,
}: DisabledEnterpriseSectionProps) {
  if (!disabled) {
    return <>{children}</>;
  }
  return (
    <fieldset
      disabled
      aria-disabled
      className={cn(
        "pointer-events-none border-0 p-0 opacity-60 select-none",
        className,
      )}
    >
      {children}
    </fieldset>
  );
}
