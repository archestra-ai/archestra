/**
 * Which agents a project may pin, given who the project is shared with.
 *
 * A pinned agent that part of the audience cannot run silently drops those
 * members back to the organization default, so the offer narrows as sharing
 * widens. The backend enforces the same rule; this only keeps the picker from
 * offering a choice the save would reject.
 *
 * Deliberately conservative where the browser cannot know the answer — team
 * membership of named individuals is not on the wire, so a team agent is not
 * offered for a `user` share even though the backend may well accept it.
 */

export type ProjectShareAudience = {
  visibility: "none" | "organization" | "team" | "user";
  teamIds: string[];
  userIds: string[];
};

export type AudienceAgent = {
  id: string;
  scope?: "personal" | "team" | "org";
  authorId?: string | null;
  teams?: Array<{ id: string; name: string }>;
  users?: Array<{ id: string }>;
};

export function agentsForProjectAudience<TAgent extends AudienceAgent>(
  agents: TAgent[],
  params: {
    share: ProjectShareAudience;
    /**
     * Whether the editor is the project's owner. The agent list is already
     * filtered to what the editor can access, so for an unshared project that
     * list *is* the answer — but only when the editor is the person who will
     * chat there. A project admin editing someone else's project cannot see
     * what that owner can reach, so the offer falls back to org-wide agents.
     */
    editorIsOwner: boolean;
  },
): TAgent[] {
  const { share, editorIsOwner } = params;

  return agents.filter((agent) => {
    // Every member of the organization can run an org agent, so it satisfies
    // any audience.
    if (agent.scope === "org") return true;

    switch (share.visibility) {
      case "organization":
        return false;
      case "team":
        return (
          agent.scope === "team" &&
          share.teamIds.length > 0 &&
          share.teamIds.every((teamId) =>
            agent.teams?.some((team) => team.id === teamId),
          )
        );
      case "user":
        return (
          agent.scope === "personal" &&
          share.userIds.every(
            (userId) =>
              agent.authorId === userId ||
              agent.users?.some((user) => user.id === userId),
          )
        );
      default:
        return editorIsOwner;
    }
  });
}
