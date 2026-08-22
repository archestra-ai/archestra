// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { Lock, type LucideIcon } from "lucide-react";
import { SCOPE_META, scopeStyles } from "@/components/scope-vocabulary";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { CollapsedBadgeList } from "./collapsed-badge-list";
import {
  capitalizeNoun,
  GROUP_ROSTER_NOUN,
  type RosterNoun,
} from "./roster-noun";

/**
 * Human-readable rendering of a document's ACL. Every entry kind the backend
 * writes is covered: `org:*`, `team:<id>` (resolved to the team name),
 * `user_email:<email>`, `group:<connectorType>_<groupId>` (resolved to the
 * roster's display name when the caller knows it), and the empty ACL
 * (fail-closed — nobody can retrieve the document until a permission sync tags
 * it). Raw tokens stay available on hover for correlation with the Groups tab.
 *
 * Entries are drawn in the app's shared scope vocabulary (`scope-vocabulary`)
 * — the same globe/people/person glyphs and colours the visibility badges use
 * elsewhere — so "who can read this" is recognisable by shape before it is
 * read. An upstream group is a team-shaped audience and borrows that styling;
 * only the fail-closed badge steps outside, in amber, because it is a warning
 * rather than an audience.
 */
export function AclBadges({
  acl,
  groupNamesByToken,
  noun = GROUP_ROSTER_NOUN,
}: {
  acl: string[];
  /** Full ACL token (`group:<connectorType>_<groupId>`) to its display name. */
  groupNamesByToken?: Map<string, string>;
  noun?: RosterNoun;
}) {
  const { data: teams } = useTeams();
  const { data: orgMembers } = useOrganizationMembers();

  if (acl.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1 border-amber-600 text-amber-600 text-xs whitespace-nowrap"
          >
            <LockedIcon className="h-3 w-3 shrink-0" />
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
      items={acl.map((entry) => {
        const { label, icon, className } = formatAclEntry({
          entry,
          teams,
          groupNamesByToken,
          noun,
          orgMembers,
        });
        return {
          id: entry,
          label,
          icon,
          className,
          // The raw token, for correlation with the Groups tab.
          title: entry,
        };
      })}
    />
  );
}

// ===== Internal pieces =====

const OrgIcon = SCOPE_META.org.icon;
const TeamIcon = SCOPE_META.team.icon;
const UserIcon = SCOPE_META.personal.icon;
const LockedIcon = Lock;

function formatAclEntry({
  entry,
  teams,
  groupNamesByToken,
  noun,
  orgMembers,
}: {
  entry: string;
  teams: { id: string; name: string }[] | undefined;
  groupNamesByToken: Map<string, string> | undefined;
  noun: RosterNoun;
  orgMembers: { name: string; email: string }[] | undefined;
}): { label: string; icon: LucideIcon; className: string } {
  if (entry === "org:*") {
    return {
      label: "Everyone in org",
      icon: OrgIcon,
      className: scopeStyles.org,
    };
  }
  if (entry.startsWith("team:")) {
    const teamId = entry.slice("team:".length);
    const team = teams?.find(({ id }) => id === teamId);
    return {
      label: `Team: ${team?.name ?? teamId}`,
      icon: TeamIcon,
      className: scopeStyles.team,
    };
  }
  if (entry.startsWith("user_email:")) {
    // A user grant reads as the org user it resolves to — a manually mapped
    // account materializes the mapped user's email here, so the resolved
    // name applies to it exactly as to an email-matched one.
    const email = entry.slice("user_email:".length);
    const user = orgMembers?.find(
      (member) => member.email.toLowerCase() === email.toLowerCase(),
    );
    return {
      label: user ? `${email} · ${user.name}` : email,
      icon: UserIcon,
      className: scopeStyles.personal,
    };
  }
  if (entry.startsWith("group:")) {
    // The roster's display name where it is known; the connector-qualified
    // group id otherwise. Either way the raw token stays on hover.
    const label = groupNamesByToken?.get(entry) ?? entry.slice("group:".length);
    return {
      label: `${capitalizeNoun(noun.singular)}: ${label}`,
      icon: TeamIcon,
      className: scopeStyles.team,
    };
  }
  return { label: entry, icon: UserIcon, className: scopeStyles.personal };
}
