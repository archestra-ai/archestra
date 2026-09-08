// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { useSession } from "@/lib/auth/auth.query";
import { useTeams } from "@/lib/teams/team.query";

export function KnowledgeBaseAccessBadge({
  visibility,
  teamIds,
  createdBy,
  compact = false,
}: {
  visibility: "org-wide" | "team-scoped" | "private";
  teamIds: string[];
  createdBy?: { id: string; name: string | null } | null;
  compact?: boolean;
}) {
  const { data: session } = useSession();
  const { data: teams } = useTeams();
  return (
    <ResourceVisibilityBadge
      scope={
        visibility === "private"
          ? "personal"
          : visibility === "team-scoped"
            ? "team"
            : "org"
      }
      teams={teamIds.map((id) => ({
        id,
        name: teams?.find((team) => team.id === id)?.name ?? "Team",
      }))}
      authorId={createdBy?.id}
      authorName={createdBy?.name}
      currentUserId={session?.user.id}
      showSelfAsMe
      compact={compact}
    />
  );
}
