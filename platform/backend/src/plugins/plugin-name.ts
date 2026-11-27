import PluginModel from "@/models/plugin";
import type { ClientType } from "@/types";

/**
 * Why a manual plugin cannot be given `displayName`, as a sentence for the
 * person (or model) naming it; null when it can.
 *
 * One person cannot hold two plugins for one client under one name, ignoring
 * letter case: the two could not be told apart in the list. The REST routes
 * and the plugin MCP tools both ask this, on create and on a rename. See
 * `PluginModel.findOwnNameTwin` for what is deliberately not compared.
 */
export async function findPluginNameProblem(params: {
  organizationId: string;
  clientType: ClientType;
  displayName: string;
  /** The acting principal, for a plugin being created. */
  creatorUserId?: string;
  /** The stored plugin, for a rename: compared within its owner's plugins. */
  existing?: {
    id: string;
    authorId: string | null;
    createdByServiceAccountId: string | null;
  };
}): Promise<string | null> {
  const owner = params.existing
    ? {
        authorId: params.existing.authorId,
        createdByServiceAccountId: params.existing.createdByServiceAccountId,
      }
    : params.creatorUserId
      ? await PluginModel.ownerOfPrincipal({
          organizationId: params.organizationId,
          userId: params.creatorUserId,
        })
      : null;
  if (!owner) return null;
  const twin = await PluginModel.findOwnNameTwin({
    organizationId: params.organizationId,
    owner,
    clientType: params.clientType,
    displayName: params.displayName,
    excludeId: params.existing?.id,
  });
  return twin
    ? `You already have a plugin named "${twin}" for this client. Give this one a different name.`
    : null;
}
