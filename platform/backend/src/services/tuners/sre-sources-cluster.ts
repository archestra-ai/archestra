import {
  createK8sClients,
  getK8sNamespace,
  isK8sConfigured,
  loadKubeConfig,
  withK8sApiRetry,
} from "@/k8s/shared";
import type { TunerCandidateScan } from "@/types/tuner";
import { listWithinBudget, sreCandidates } from "./sre-sources";

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
  const scan = {
    namespaces,
    budget: MAX_OBJECTS_PER_KIND,
    pageSize: PAGE_SIZE,
  };

  const [pods, deployments, statefulSets] = await Promise.all([
    listWithinBudget({
      ...scan,
      fetchPage: (request) =>
        withK8sApiRetry(() => coreApi.listNamespacedPod(request), {
          label: "tuner-sre-list-pods",
        }),
    }),
    listWithinBudget({
      ...scan,
      fetchPage: (request) =>
        withK8sApiRetry(() => appsApi.listNamespacedDeployment(request), {
          label: "tuner-sre-list-deployments",
        }),
    }),
    listWithinBudget({
      ...scan,
      fetchPage: (request) =>
        withK8sApiRetry(() => appsApi.listNamespacedStatefulSet(request), {
          label: "tuner-sre-list-statefulsets",
        }),
    }),
  ]);

  const candidates = sreCandidates(
    {
      pods: pods.items,
      deployments: deployments.items,
      statefulSets: statefulSets.items,
    },
    now,
  );
  return {
    candidates,
    complete: [pods, deployments, statefulSets].every((l) => l.complete),
  };
}

// === Internal helpers ===

const PAGE_SIZE = 500;
const MAX_OBJECTS_PER_KIND = 5000;
