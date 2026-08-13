// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { CollapsedBadgeList } from "./collapsed-badge-list";

/**
 * Human-readable rendering of a document's ACL. Every entry kind the backend
 * writes is covered: `org:*`, `team:<id>` (resolved to the team name),
 * `user_email:<email>`, `group:<connectorType>_<groupId>`, and the empty ACL
 * (fail-closed — nobody can retrieve the document until a permission sync tags
 * it). Raw tokens stay available on hover for correlation with the Groups tab.
 */
export function AclBadges({ acl }: { acl: string[] }) {
  const { data: teams } = useTeams();
  const { data: orgMembers } = useOrganizationMembers();

  if (acl.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="border-amber-600 text-amber-600 text-xs whitespace-nowrap"
          >
            Locked
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          No one can retrieve this document yet — it stays access-restricted
          until a permission sync tags it with its source permissions.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <CollapsedBadgeList
      items={acl.map((entry) => ({
        id: entry,
        label: formatAclEntry(entry, teams, orgMembers),
        // The raw token, for correlation with the Groups tab.
        title: entry,
      }))}
    />
  );
}

function formatAclEntry(
  entry: string,
  teams: { id: string; name: string }[] | undefined,
  orgMembers: { name: string; email: string }[] | undefined,
): string {
  if (entry === "org:*") {
    return "Everyone in org";
  }
  if (entry.startsWith("team:")) {
    const teamId = entry.slice("team:".length);
    const team = teams?.find(({ id }) => id === teamId);
    return `Team: ${team?.name ?? teamId}`;
  }
  if (entry.startsWith("user_email:")) {
    // A user grant reads as the org user it resolves to — a manually mapped
    // account materializes the mapped user's email here, so the resolved
    // name applies to it exactly as to an email-matched one.
    const email = entry.slice("user_email:".length);
    const user = orgMembers?.find(
      (member) => member.email.toLowerCase() === email.toLowerCase(),
    );
    return user ? `${email} · ${user.name}` : email;
  }
  if (entry.startsWith("group:")) {
    return `Group: ${entry.slice("group:".length)}`;
  }
  return entry;
}
