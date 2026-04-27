import { and, asc, count, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertK8sCluster, K8sCluster, UpdateK8sCluster } from "@/types";
import { ApiError } from "@/types";
import {
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedSecret,
} from "@/utils/crypto";

class K8sClusterModel {
  static async create({
    organizationId,
    name,
    kubeconfig,
  }: InsertK8sCluster): Promise<K8sCluster> {
    const [cluster] = await db
      .insert(schema.k8sClustersTable)
      .values({
        organizationId,
        name,
        kubeconfig: encryptSecretValue({ kubeconfig }),
      })
      .returning();
    if (!cluster) {
      throw new ApiError(500, "Failed to create K8s cluster");
    }
    return decryptKubeconfigRow(cluster);
  }

  static async findAll(organizationId: string): Promise<K8sCluster[]> {
    const clusters = await db
      .select()
      .from(schema.k8sClustersTable)
      .where(eq(schema.k8sClustersTable.organizationId, organizationId))
      .orderBy(asc(schema.k8sClustersTable.createdAt));
    return clusters.map(decryptKubeconfigRow);
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<K8sCluster | null> {
    const [cluster] = await db
      .select()
      .from(schema.k8sClustersTable)
      .where(
        and(
          eq(schema.k8sClustersTable.id, id),
          eq(schema.k8sClustersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return cluster ? decryptKubeconfigRow(cluster) : null;
  }

  static async update(
    id: string,
    organizationId: string,
    data: UpdateK8sCluster,
  ): Promise<K8sCluster> {
    const updateData = data.kubeconfig
      ? {
          ...data,
          kubeconfig: encryptSecretValue({ kubeconfig: data.kubeconfig }),
        }
      : data;
    const [cluster] = await db
      .update(schema.k8sClustersTable)
      .set(updateData)
      .where(
        and(
          eq(schema.k8sClustersTable.id, id),
          eq(schema.k8sClustersTable.organizationId, organizationId),
        ),
      )
      .returning();
    if (!cluster) {
      throw new ApiError(404, "K8s cluster not found");
    }
    return decryptKubeconfigRow(cluster);
  }

  static async delete(id: string, organizationId: string): Promise<void> {
    const inUseCount = await countMcpServersByClusterId(id);
    if (inUseCount > 0) {
      throw new ApiError(
        400,
        `Cannot delete cluster: ${inUseCount} MCP server${inUseCount === 1 ? "" : "s"} still use${inUseCount === 1 ? "s" : ""} it`,
      );
    }
    await db
      .delete(schema.k8sClustersTable)
      .where(
        and(
          eq(schema.k8sClustersTable.id, id),
          eq(schema.k8sClustersTable.organizationId, organizationId),
        ),
      );
  }

  static async findByIdInternal(id: string): Promise<K8sCluster | null> {
    const [cluster] = await db
      .select()
      .from(schema.k8sClustersTable)
      .where(eq(schema.k8sClustersTable.id, id))
      .limit(1);
    return cluster ? decryptKubeconfigRow(cluster) : null;
  }
}

export default K8sClusterModel;

function decryptKubeconfigRow(cluster: K8sCluster): K8sCluster {
  if (isEncryptedSecret(cluster.kubeconfig)) {
    const decrypted = decryptSecretValue(cluster.kubeconfig);
    return { ...cluster, kubeconfig: decrypted.kubeconfig as string };
  }
  return cluster;
}

async function countMcpServersByClusterId(clusterId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(schema.mcpServersTable)
    .where(eq(schema.mcpServersTable.k8sClusterId, clusterId));
  return row?.total ?? 0;
}
