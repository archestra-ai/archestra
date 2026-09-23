import type {
  ResourcePermissionAction,
  ScopedResource,
} from "@archestra/shared";
import { onTestFinished, vi } from "vitest";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";

/**
 * Give a role a grant at `*` on a resource, the way an administrator does on
 * the organization Permissions screen: every object of that kind.
 */
export async function grantRoleEverywhere(params: {
  organizationId: string;
  resource: ScopedResource;
  roleId: string;
  actions: ResourcePermissionAction[];
}) {
  const key = {
    organizationId: params.organizationId,
    resource: params.resource,
    scope: "*",
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [
      ...(policy?.grants ?? []),
      {
        subject: { type: "role", id: params.roleId },
        actions: params.actions,
      },
    ],
  });
}

/**
 * For suites that stub role permissions wholesale: answer a grant at `*` on
 * these resources as held, the way a role carrying the retired `admin` action
 * used to pass. Every other grant check still reads the database.
 */
export function grantEverywhere(
  resources: readonly ScopedResource[],
  /** Consulted on every check, for suites that flip the stub per test. */
  held: () => boolean | Promise<boolean> = () => true,
) {
  const allows = ResourcePermissions.allows.bind(ResourcePermissions);
  const spy = vi
    .spyOn(ResourcePermissions, "allows")
    .mockImplementation(async (params) =>
      params.scope === "*" && resources.includes(params.resource)
        ? held()
        : allows(params),
    );
  // Scoped to the test that asked for it, so a later test starts without it.
  onTestFinished(() => spy.mockRestore());
  return spy;
}
