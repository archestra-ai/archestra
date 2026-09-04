"use client";

import { Globe, Lock, Users } from "lucide-react";
import {
  TeamVisibilityPicker,
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useTeams } from "@/lib/teams/team.query";

export type KnowledgeFileVisibility = "org-wide" | "team-scoped" | "private";

/**
 * Visibility for a repository file or directory.
 *
 * Deliberately separate from the connector visibility selector: a connector
 * cannot be "private to one person", and it carries an auto-sync mode that has
 * no meaning for an uploaded file — which has no upstream to sync from. These
 * three values map straight onto the ACL tokens a document ends up carrying.
 */
const OPTIONS: VisibilityOption<KnowledgeFileVisibility>[] = [
  {
    value: "org-wide",
    label: "Organization",
    description: "Anyone in your organization can find this",
    icon: Globe,
  },
  {
    value: "team-scoped",
    label: "Teams",
    description: "Only members of the teams you pick",
    icon: Users,
  },
  {
    value: "private",
    label: "Only me",
    description: "Nobody else can see it, in the repository or in retrieval",
    icon: Lock,
  },
];

export function FileVisibilitySelector({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  label = "Who can see this",
  description,
}: {
  visibility: KnowledgeFileVisibility;
  onVisibilityChange: (visibility: KnowledgeFileVisibility) => void;
  teamIds: string[];
  onTeamIdsChange: (teamIds: string[]) => void;
  label?: string;
  description?: string;
}) {
  const { data: teams } = useTeams();

  return (
    <div className="space-y-2">
      <VisibilitySelector
        label={label}
        description={description}
        value={visibility}
        options={OPTIONS}
        onValueChange={onVisibilityChange}
      />

      {visibility === "team-scoped" && (
        <TeamVisibilityPicker
          teams={teams ?? []}
          value={teamIds}
          onChange={onTeamIdsChange}
          required
        />
      )}
    </div>
  );
}
