import type * as k8s from "@kubernetes/client-node";
import config from "@/config";

export async function resolveRuntimeOwnerReferences(
  rbacApi: k8s.RbacAuthorizationV1Api | undefined,
  namespace: string,
): Promise<k8s.V1OwnerReference[] | undefined> {
  const name = config.orchestrator.kubernetes.runtimeOwnerRoleName;
  if (!name || !rbacApi) return undefined;

  const owner = await rbacApi.readNamespacedRole({ name, namespace });
  if (!owner.metadata?.uid || !owner.metadata.name) return undefined;
  return [
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      name: owner.metadata.name,
      uid: owner.metadata.uid,
      controller: false,
      blockOwnerDeletion: false,
    },
  ];
}
