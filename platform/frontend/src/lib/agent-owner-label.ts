/**
 * Personal agents are auto-seeded one per member, so every member's copy
 * carries the same name — a list of them reads as repeated "My Assistant" /
 * "My Gateway" rows. Attribute those to their owner; agents with a name their
 * author chose need no qualifier.
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
