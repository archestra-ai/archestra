// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth";
import { AgentModel } from "@/models";
import { ApiError } from "@/types";

/**
 * Guards a change to an agent's Microsoft Entra agent identity binding.
 *
 * The binding decides which Entra consents and Conditional Access policies a
 * tool call runs under, so it is an identity decision, not an agent edit:
 * changing it takes `identityProvider:update`. An agent identity also belongs
 * to one agent, or downstream audit could not tell the agents apart.
 */
export async function assertEntraAgentIdentityChange(params: {
  organizationId: string;
  userId: string;
  agentId: string | null;
  previous: string | null;
  next: string | null | undefined;
}): Promise<void> {
  if (params.next === undefined) return;
  const next = normalize(params.next);
  if (next === normalize(params.previous)) return;

  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "identityProvider",
    "update",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      "Changing an agent's Microsoft Entra agent identity requires the identityProvider:update permission.",
    );
  }

  if (!next) return;
  const boundAgentId = await AgentModel.findIdByEntraAgentIdentityId({
    organizationId: params.organizationId,
    entraAgentIdentityId: next,
  });
  if (boundAgentId && boundAgentId !== params.agentId) {
    throw new ApiError(
      409,
      "This Microsoft Entra agent identity is already bound to another agent. Create a separate agent identity for each agent.",
    );
  }
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}
