import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  loadKubeConfig,
  withK8sApiRetry,
} from "@/k8s/shared";
import type { TunerCandidateScan } from "@/types/tuner";
import { type SreClusterSnapshot, sreCandidates } from "./sre-sources";

class SreClusterNotConfiguredError extends Error {
  constructor() {
    super(
      "Kubernetes is not configured for the backend; the SRE tuner cannot scan the cluster",
    );
    this.name = "SreClusterNotConfiguredError";
  }
}

/** Scans the MCP-server namespace and the platform's own namespace. */
export async function collectSreCandidates(
  now: Date,
): Promise<TunerCandidateScan> {
  if (!isK8sConfigured()) {
    throw new SreClusterNotConfiguredError();
  }
  const { kubeConfig, namespace } = loadKubeConfig();
  const { coreApi, appsApi } = createK8sClients(kubeConfig, namespace);
  const platformNamespace = process.env.POD_NAMESPACE || getK8sNamespace();
  const namespaces = [...new Set([namespace, platformNamespace])];

  const snapshots = await Promise.all(
    namespaces.map(async (ns): Promise<SreClusterSnapshot> => {
      const [pods, deployments, statefulSets] = await Promise.all([
        withK8sApiRetry(() => coreApi.listNamespacedPod({ namespace: ns }), {
          label: "tuner-sre-list-pods",
        }),
        withK8sApiRetry(
          () => appsApi.listNamespacedDeployment({ namespace: ns }),
          { label: "tuner-sre-list-deployments" },
        ),
        withK8sApiRetry(
          () => appsApi.listNamespacedStatefulSet({ namespace: ns }),
          { label: "tuner-sre-list-statefulsets" },
        ),
      ]);
      return {
        pods: pods.items,
        deployments: deployments.items,
        statefulSets: statefulSets.items,
      };
    }),
  );

  const candidates = sreCandidates(
    {
      pods: snapshots.flatMap((s) => s.pods),
      deployments: snapshots.flatMap((s) => s.deployments),
      statefulSets: snapshots.flatMap((s) => s.statefulSets),
    },
    now,
  );
  return { candidates, complete: true };
}
