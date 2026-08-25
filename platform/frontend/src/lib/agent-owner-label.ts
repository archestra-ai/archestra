import type { ResourceVisibilityScope } from "@archestra/shared";

/** What a surface can truthfully say about who an agent belongs to. */
export type AgentOwner =
  /** A personal agent belonging to the person looking at it. */
  | { kind: "self"; email: string | null }
  /** A personal agent belonging to somebody else. */
  | { kind: "user"; email: string }
  /**
   * A personal agent whose author's account was deleted, named from the email
   * captured at deletion time. "Their account is gone" is a better answer than
   * either a bare address (which invites someone to go looking for a colleague
   * who has left) or a shrug.
   */
  | { kind: "deleted"; email: string }
  /**
   * A personal agent with no author on record and nothing retained about them:
   * an agent orphaned before that capture existed. `agents.author_id` is
   * `ON DELETE SET NULL`, so the owner is not merely unloaded, it is gone.
   * Callers must say that rather than substitute the scope — the word
   * "Personal" in an owner column reads as "mine", which is how these rows came
   * to be mistaken for the viewer's own.
   */
  | { kind: "unknown" }
  /**
   * A team- or organization-scoped agent. It belongs to the team or the org,
   * not to a person, so the scope IS the answer here — unlike the personal
   * case, where it is a non-answer wearing the same words.
   */
  | { kind: "scope"; scope: Exclude<ResourceVisibilityScope, "personal"> };

/**
 * Who an agent belongs to, as one decision every surface can render its own
 * way.
 *
 * `ownerId` rather than the email decides "is this mine": the email is a
 * display string, and it is null on exactly the rows that most need telling
 * apart.
 */
export function describeAgentOwner(
  agent: {
    scope: ResourceVisibilityScope;
    ownerId: string | null;
    ownerEmail: string | null;
    formerOwnerEmail?: string | null;
  },
  currentUserId: string | null | undefined,
): AgentOwner {
  if (agent.scope !== "personal") {
    return { kind: "scope", scope: agent.scope };
  }
  if (currentUserId && agent.ownerId === currentUserId) {
    return { kind: "self", email: agent.ownerEmail };
  }
  if (agent.ownerEmail) {
    return { kind: "user", email: agent.ownerEmail };
  }
  // The live author is checked first: the retained identity is only ever
  // written as an account is deleted, so the two cannot both be current.
  if (agent.formerOwnerEmail) {
    return { kind: "deleted", email: agent.formerOwnerEmail };
  }
  return { kind: "unknown" };
}

/**
 * The short qualifier form, for surfaces that append the owner to an agent's
 * name rather than giving it a column of its own — "My Assistant
 * (kim@example.com)". Null means "add nothing", so an unattributable agent
 * keeps its bare name instead of gaining a word that would read as an owner.
 *
 * Personal agents are auto-seeded one per member, so every member's copy
 * carries the same name — a list of them reads as repeated "My Assistant" /
 * "My Gateway" rows. Agents with a name their author chose need no qualifier.
 *
 * The owner is spelled as an email rather than a display name because display
 * names collide too, which would leave the rows just as indistinguishable.
 */
export function agentOwnerLabel(agent: {
  scope: string;
  ownerEmail: string | null;
}): string | null {
  if (agent.scope !== "personal") return null;
  return agent.ownerEmail;
}
