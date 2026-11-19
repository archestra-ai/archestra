// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth";
import { AgentIdentityBindingModel } from "@/models";
import { agentIdentityKind } from "@/services/identity-providers/enterprise-managed/exchange";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";
import { ApiError } from "@/types";
import type { AgentIdentityBinding } from "@/types/agent-identity-binding";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * Replaces the identities an agent acts as at identity providers.
 *
 * A binding decides whose consents and policies a tool call runs under at the
 * identity provider, so it is an identity decision, not an agent edit:
 * changing it takes `identityProvider:update`. An identity also belongs to one
 * agent, or downstream audit could not tell the agents apart.
 */
export async function replaceAgentIdentityBindings(params: {
  organizationId: string;
  userId: string;
  agentId: string;
  bindings: AgentIdentityBinding[];
}): Promise<AgentIdentityBinding[]> {
  const next = params.bindings.map((binding) => ({
    identityProviderId: binding.identityProviderId,
    externalId: binding.externalId.trim(),
  }));
  const previous = await AgentIdentityBindingModel.findForAgent(params.agentId);
  if (sameBindings(previous, next)) {
    return previous;
  }

  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "identityProvider",
    "update",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      "Changing an agent's identities requires the identityProvider:update permission.",
    );
  }

  const seen = new Set<string>();
  for (const binding of next) {
    if (seen.has(binding.identityProviderId)) {
      throw new ApiError(
        400,
        "An agent has at most one identity per identity provider.",
      );
    }
    seen.add(binding.identityProviderId);
    // A binding kept as stored was checked when it was made. Checking it
    // again would block every other change once its provider stops taking
    // bindings, such as on a switch to SPIFFE IDs.
    const kept = previous.some(
      (stored) =>
        stored.identityProviderId === binding.identityProviderId &&
        stored.externalId === binding.externalId,
    );
    if (kept) continue;
    await assertBindable({ organizationId: params.organizationId, binding });
    const boundAgentId =
      await AgentIdentityBindingModel.findAgentIdByExternalId(binding);
    if (boundAgentId && boundAgentId !== params.agentId) {
      throw identityTakenError();
    }
  }

  try {
    await AgentIdentityBindingModel.replaceForAgent({
      agentId: params.agentId,
      bindings: next,
    });
  } catch (error) {
    // Another agent took the identity between the check and the write.
    if (
      isUniqueConstraintError(
        error,
        "agent_identity_bindings_identity_provider_external_id_idx",
      )
    ) {
      throw identityTakenError();
    }
    // Another save of this agent's identities landed first.
    if (
      isUniqueConstraintError(
        error,
        "agent_identity_bindings_agent_id_identity_provider_id_pk",
      )
    ) {
      throw new ApiError(
        409,
        "This agent's identities changed while saving. Reload and try again.",
      );
    }
    throw error;
  }
  return AgentIdentityBindingModel.findForAgent(params.agentId);
}

// === Internal helpers ===

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider must be one of the organization's OIDC providers set up for
 * agent identities: an Entra Agent ID blueprint, whose agent identities are
 * GUIDs, or an agent identity key for Okta AI agents and RFC 8693 actors.
 */
async function assertBindable(params: {
  organizationId: string;
  binding: AgentIdentityBinding;
}): Promise<void> {
  const identityProvider = await findExternalIdentityProviderById(
    params.binding.identityProviderId,
    { organizationId: params.organizationId },
  );
  if (!identityProvider) {
    throw new ApiError(404, "Identity provider not found");
  }

  const kind = agentIdentityKind(identityProvider);
  if (kind === "spiffe") {
    throw new ApiError(
      400,
      "This identity provider takes the SPIFFE ID every agent is issued automatically: there is nothing to bind.",
    );
  }
  if (kind === "entra" && !GUID_PATTERN.test(params.binding.externalId)) {
    throw new ApiError(
      400,
      "A Microsoft Entra agent identity is the agent identity's app ID, a GUID.",
    );
  }
  if (!kind) {
    throw new ApiError(
      400,
      "This identity provider is not set up for agent identities. Configure an Entra Agent ID blueprint, or an agent private key under Agent Identities, in its Tool Access settings first.",
    );
  }
}

function identityTakenError(): ApiError {
  return new ApiError(
    409,
    "This identity is already bound to another agent, possibly one in the trash: restore and unbind it, or delete it permanently. Create a separate identity for each agent.",
  );
}

function sameBindings(
  previous: AgentIdentityBinding[],
  next: AgentIdentityBinding[],
): boolean {
  const key = (bindings: AgentIdentityBinding[]) =>
    bindings
      .map(
        (binding) => `${binding.identityProviderId}\u0000${binding.externalId}`,
      )
      .sort()
      .join("\u0001");
  return key(previous) === key(next);
}
