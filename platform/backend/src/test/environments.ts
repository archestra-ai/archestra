import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createEnvironment } from "@/services/environments/environment";

/**
 * An environment nobody may deploy into without a grant of their own: the
 * organization and role grants a new environment gets are removed. This is what a
 * `restricted` environment was before access moved to grants.
 */
export async function createRestrictedEnvironment(
  params: Parameters<typeof createEnvironment>[0],
) {
  const environment = await createEnvironment(params);
  const key = {
    organizationId: params.organizationId,
    resource: "environment" as const,
    scope: environment.id,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: (policy?.grants ?? []).filter(
      (grant) =>
        grant.subject.type !== "organization" && grant.subject.type !== "role",
    ),
  });
  return environment;
}

/** Let one user deploy into one environment, keeping its other grants. */
export async function grantEnvironmentUse(params: {
  organizationId: string;
  environmentId: string;
  userId: string;
}) {
  const key = {
    organizationId: params.organizationId,
    resource: "environment" as const,
    scope: params.environmentId,
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: [
      ...(policy?.grants ?? []).filter(
        (grant) =>
          grant.subject.type !== "user" || grant.subject.id !== params.userId,
      ),
      {
        subject: { type: "user", id: params.userId },
        actions: ["read", "use"],
      },
    ],
  });
}
