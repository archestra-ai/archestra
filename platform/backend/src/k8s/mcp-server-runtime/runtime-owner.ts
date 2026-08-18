import type * as k8s from "@kubernetes/client-node";
import config from "@/config";

export async function resolveRuntimeOwnerReferences(
  coreApi: k8s.CoreV1Api,
  namespace: string,
): Promise<k8s.V1OwnerReference[] | undefined> {
  const name = config.orchestrator.kubernetes.runtimeOwnerConfigMapName;
  if (!name) return undefined;

  const owner = await coreApi.readNamespacedConfigMap({ name, namespace });
  if (!owner.metadata?.uid || !owner.metadata.name) return undefined;
  return [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      name: owner.metadata.name,
      uid: owner.metadata.uid,
      controller: false,
      blockOwnerDeletion: false,
    },
  ];
}
