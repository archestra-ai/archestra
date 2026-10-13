// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  hasScopedPermission,
  type ResourcePermissionAction,
} from "@archestra/shared";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError, type RuntimeCredentialDefinition } from "@/types";

/**
 * Who may reach one saved credential.
 *
 * Reaching a credential used to be a question about the caller alone: hold
 * `credential:update` and every credential in the organization — every GitHub
 * App private key among them — was yours to change. It is now asked of the
 * credential: a grant on it, or at `*` for every credential, decides.
 *
 * Only the routes and tools a person drives go through here. Resolving a
 * credential's value for a run, a sync or an installation is authorized by
 * the thing it is resolved for, not by the person who configured it.
 */
export class CredentialAccess {
  /** The listed credentials this caller may see. */
  static async filterReadable<T extends { id: string }>(params: {
    organizationId: string;
    userId: string;
    items: T[];
  }): Promise<T[]> {
    const readable = await ResourcePermissions.getPermittedIds({
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "credential",
      scopes: params.items.map((item) => item.id),
      action: "read",
    });
    return params.items.filter((item) => readable.has(item.id));
  }

  /**
   * Require `action` on every credential: a grant at `*`, not one gathered
   * object by object. For changes that can reach any credential, such as
   * helper code a credential may later be bound to.
   */
  static async requireOnEvery(params: {
    organizationId: string;
    userId: string;
    action: ResourcePermissionAction;
    message: string;
  }): Promise<void> {
    const context = {
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "credential" as const,
      scope: "*",
    };
    const { grants } = await ResourcePermissions.getEffective(context);
    if (
      !hasScopedPermission({
        grants,
        required: { ...context, action: params.action },
      })
    )
      throw new ApiError(403, params.message);
  }

  /**
   * Require `use` on the credential a key names, refusing with 403 rather
   * than hiding it. A key with no credential behind it would hand over
   * whichever one is created under it later, so it takes `use` on every one.
   */
  static async requireUseOfKey(params: {
    organizationId: string;
    userId: string;
    key: string;
    message: string;
  }): Promise<void> {
    const definition = await RuntimeCredentialDefinitionModel.find(params);
    if (!definition) {
      await CredentialAccess.requireOnEvery({ ...params, action: "use" });
      return;
    }
    const permitted = await ResourcePermissions.getPermittedIds({
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "credential",
      scopes: [definition.id],
      action: "use",
    });
    if (!permitted.has(definition.id)) throw new ApiError(403, params.message);
  }

  /**
   * Require `action` on one credential by id.
   *
   * A credential the caller cannot even see answers as missing, so its
   * existence is not disclosed; one they can see but not act on is a 403.
   */
  static async require(params: {
    organizationId: string;
    userId: string;
    id: string;
    action: ResourcePermissionAction;
  }): Promise<void> {
    const context = {
      organizationId: params.organizationId,
      userId: params.userId,
      resource: "credential" as const,
      scope: params.id,
    };
    const { grants } = await ResourcePermissions.getEffective(context);
    if (
      !hasScopedPermission({ grants, required: { ...context, action: "read" } })
    )
      throw new ApiError(404, "Credential not found");
    if (
      params.action !== "read" &&
      !hasScopedPermission({
        grants,
        required: { ...context, action: params.action },
      })
    )
      throw new ApiError(
        403,
        "You do not have permission to perform this action on this credential",
      );
  }

  /** {@link CredentialAccess.require} for routes that name a credential by key. */
  static async requireByKey(params: {
    organizationId: string;
    userId: string;
    key: string;
    action: ResourcePermissionAction;
  }): Promise<RuntimeCredentialDefinition> {
    const definition = await RuntimeCredentialDefinitionModel.find({
      organizationId: params.organizationId,
      key: params.key,
    });
    if (!definition) throw new ApiError(404, "Credential not found");
    await CredentialAccess.require({ ...params, id: definition.id });
    return definition;
  }
}
