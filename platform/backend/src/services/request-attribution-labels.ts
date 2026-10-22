import AttributionLabelModel from "@/models/attribution-label";
import type { AttributionLabels } from "@/types/attribution-label";
import type { InteractionAuthMethod } from "@/types/interaction";

/** Caller metadata never participates in billing attribution. */
export async function resolveRequestAttributionLabels(params: {
  organizationId: string;
  authMethod?: InteractionAuthMethod;
  serviceAccountId?: string;
  billingTeamId?: string;
  virtualKeyId?: string;
  passthroughVirtualKeyId?: string;
  oauthClientId?: string;
  proxyLabels?: { key: string; value: string }[];
}): Promise<AttributionLabels> {
  const rows = await AttributionLabelModel.findForRequest({
    organizationId: params.organizationId,
    serviceAccountId: params.serviceAccountId,
    billingTeamId: params.billingTeamId,
    virtualKeyId:
      params.authMethod === "virtual_key"
        ? params.virtualKeyId
        : params.authMethod === "passthrough_virtual_key"
          ? params.passthroughVirtualKeyId
          : undefined,
    oauthClientId:
      params.authMethod === "oauth_client_credentials"
        ? params.oauthClientId
        : undefined,
  });
  // Proxy defaults < service account < billing team < authenticated credential.
  // A single value per key keeps grouping additive, including cost centers.
  const labels = new Map(
    params.proxyLabels?.map(({ key, value }) => [key, value]),
  );
  for (const { key, value } of rows.sort((a, b) => a.priority - b.priority)) {
    labels.set(key, value);
  }
  return Object.fromEntries(labels);
}
