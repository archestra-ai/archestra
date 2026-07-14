// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Shown when a connector's group membership snapshot is larger than the API
 * returns. The tables below it are then showing part of the snapshot, and
 * saying so matters: an admin looking for a member who is missing from the list
 * would otherwise conclude the sync never picked them up.
 *
 * Access control itself is unaffected — it resolves per user against the whole
 * snapshot in the database, not against this listing.
 */
export function MembershipTruncationNotice({
  totalMemberships,
}: {
  totalMemberships: number;
}) {
  return (
    <Alert>
      <Info className="h-4 w-4" />
      <AlertDescription>
        This connector has {totalMemberships.toLocaleString()} group
        memberships, more than this page lists. The table below shows the first
        of them, so a member you are looking for may not be in it. Access
        control still uses the full snapshot — only this listing is shortened.
      </AlertDescription>
    </Alert>
  );
}
