// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  credentialRequiresPerUserScope,
  type ResourcePermissionGrant,
  type SupportedProvider,
} from "@archestra/shared";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { ApiError } from "@/types";

/** Personal subscription credentials cannot become shared through resource grants. */
export class CredentialResourcePermissions {
  static validateProvider(params: {
    provider: SupportedProvider;
    apiKey: string | null | undefined;
    ownerId: string | null;
    grants: ResourcePermissionGrant[];
  }) {
    if (credentialRequiresPerUserScope(params)) assertOwnerOnly(params);
  }

  static async validateVirtual(params: {
    keyType: string;
    ownerId: string | null;
    grants: ResourcePermissionGrant[];
    providerApiKeyIds: string[];
  }) {
    if (params.keyType === "passthrough") {
      assertOwnerOnly(params);
      return;
    }
    const keys = await LlmProviderApiKeyModel.findByIds(
      params.providerApiKeyIds,
    );
    for (const key of keys) {
      const apiKey = key.secretId
        ? await getSecretValueForLlmProviderApiKey(key.secretId)
        : undefined;
      if (
        credentialRequiresPerUserScope({ provider: key.provider, apiKey }) &&
        key.userId !== params.ownerId
      ) {
        throw new ApiError(
          403,
          "Personal account credentials must belong to the virtual key owner.",
        );
      }
      CredentialResourcePermissions.validateProvider({
        provider: key.provider,
        apiKey,
        ownerId: params.ownerId,
        grants: params.grants,
      });
    }
  }

  static async validatePolicy(params: {
    organizationId: string;
    resource: string;
    scope: string;
    grants: ResourcePermissionGrant[];
  }) {
    if (params.scope === "*") return;
    if (params.resource === "llmProviderApiKey") {
      const key = await LlmProviderApiKeyModel.findById(params.scope);
      if (!key || key.organizationId !== params.organizationId) return;
      CredentialResourcePermissions.validateProvider({
        provider: key.provider,
        apiKey: key.secretId
          ? await getSecretValueForLlmProviderApiKey(key.secretId)
          : undefined,
        ownerId: key.userId,
        grants: params.grants,
      });
    } else if (params.resource === "llmVirtualKey") {
      const key = await VirtualApiKeyModel.findByIdWithParentInfo(
        params.scope,
        params.organizationId,
      );
      if (!key) return;
      await CredentialResourcePermissions.validateVirtual({
        keyType: key.keyType,
        ownerId: key.authorId,
        grants: params.grants,
        providerApiKeyIds: key.providerApiKeys.map(
          (mapping) => mapping.providerApiKeyId,
        ),
      });
    }
  }

  static async currentGrants(params: {
    organizationId: string;
    resource: "llmProviderApiKey" | "llmVirtualKey";
    scope: string;
  }) {
    return (await ResourcePermissionPolicyModel.find(params))?.grants ?? [];
  }
}

function assertOwnerOnly(params: {
  ownerId: string | null;
  grants: ResourcePermissionGrant[];
}) {
  if (
    params.grants.some(
      (grant) =>
        grant.actions.length &&
        (grant.subject.type !== "user" || grant.subject.id !== params.ownerId),
    )
  ) {
    throw new ApiError(
      400,
      "Personal account credentials cannot be shared. Each person must connect their own account.",
    );
  }
}
