import config from "@/config";
import {
  buildKubeConfig,
  createK8sClients,
  type K8sClients,
} from "@/k8s/shared";
import logger from "@/logging";
import ClusterModel from "@/models/cluster";
import SecretModel from "@/models/secret";
import type { Cluster } from "@/types/cluster";
import type { McpServer } from "@/types/mcp-server";

const KUBECONFIG_SECRET_KEY = "kubeconfig";

type K8sClientsBundle = {
  clients: K8sClients;
  namespace: string;
  clusterId: string;
};

export class ClusterRegistry {
  private cache = new Map<string, K8sClientsBundle>();
  private inFlight = new Map<string, Promise<K8sClientsBundle>>();

  async resolveForServer(mcpServer: McpServer): Promise<K8sClientsBundle> {
    const cluster = await this.pickClusterForServer(mcpServer);
    return this.getOrBuild(cluster);
  }

  invalidate(clusterId: string): void {
    this.cache.delete(clusterId);
    this.inFlight.delete(clusterId);
  }

  invalidateAll(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private async pickClusterForServer(mcpServer: McpServer): Promise<Cluster> {
    if (mcpServer.clusterId) {
      const cluster = await ClusterModel.getById(mcpServer.clusterId);
      if (!cluster) {
        throw new Error(`cluster ${mcpServer.clusterId} not found`);
      }
      return cluster;
    }

    logger.warn(
      { mcpServerId: mcpServer.id },
      `mcp_server ${mcpServer.id} has null cluster_id, falling back to default resolution`,
    );

    if (mcpServer.ownerId && !mcpServer.teamId) {
      const personalDefault = await ClusterModel.getPersonalDefault();
      if (personalDefault) return personalDefault;
    }

    return ClusterModel.getDefault();
  }

  private async getOrBuild(cluster: Cluster): Promise<K8sClientsBundle> {
    const cached = this.cache.get(cluster.id);
    if (cached) return cached;

    const inFlight = this.inFlight.get(cluster.id);
    if (inFlight) return inFlight;

    const promise = this.build(cluster)
      .then((bundle) => {
        this.cache.set(cluster.id, bundle);
        this.inFlight.delete(cluster.id);
        return bundle;
      })
      .catch((err) => {
        this.inFlight.delete(cluster.id);
        throw err;
      });

    this.inFlight.set(cluster.id, promise);
    return promise;
  }

  private async build(cluster: Cluster): Promise<K8sClientsBundle> {
    if (
      cluster.name === "default" &&
      cluster.kubeconfigSecretId === null &&
      cluster.loadFromCluster === false &&
      cluster.namespace === null
    ) {
      const { kubeConfig, namespace } = buildKubeConfig({
        kubeconfigPath: config.orchestrator.kubernetes.kubeconfig,
        loadFromCluster:
          config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster,
        namespace: config.orchestrator.kubernetes.namespace,
      });
      return {
        clients: createK8sClients(kubeConfig, namespace),
        namespace,
        clusterId: cluster.id,
      };
    }

    let kubeconfigYaml: string | undefined;
    if (cluster.kubeconfigSecretId) {
      const secret = await SecretModel.findById(cluster.kubeconfigSecretId);
      if (!secret) {
        throw new Error(
          `kubeconfig secret ${cluster.kubeconfigSecretId} not found`,
        );
      }
      const blob = secret.secret as { [KUBECONFIG_SECRET_KEY]?: string };
      kubeconfigYaml = blob[KUBECONFIG_SECRET_KEY];
      if (!kubeconfigYaml) {
        throw new Error(
          `kubeconfig secret ${cluster.kubeconfigSecretId} missing '${KUBECONFIG_SECRET_KEY}' key`,
        );
      }
    }

    const { kubeConfig, namespace } = buildKubeConfig({
      kubeconfigYaml,
      loadFromCluster: cluster.loadFromCluster,
      namespace: cluster.namespace ?? "default",
    });

    return {
      clients: createK8sClients(kubeConfig, namespace),
      namespace,
      clusterId: cluster.id,
    };
  }
}

export const clusterRegistry = new ClusterRegistry();
