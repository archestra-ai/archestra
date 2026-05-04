import { and, asc, eq, ne, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { validateKubeconfigContent } from "@/k8s/shared";
import {
  type Cluster,
  ClusterInUseError,
  type InsertClusterInput,
  InsertClusterInputSchema,
  type UpdateClusterInput,
  UpdateClusterInputSchema,
} from "@/types/cluster";
import SecretModel from "./secret";

/**
 * Key inside the secret JSON blob where kubeconfig YAML is stored.
 * The schema does not pin this name; we pick a stable key for round-tripping.
 */
const KUBECONFIG_SECRET_KEY = "kubeconfig";

class ClusterModel {
  static async list(): Promise<Cluster[]> {
    return await db
      .select()
      .from(schema.clustersTable)
      .orderBy(asc(schema.clustersTable.createdAt));
  }

  static async getById(id: string): Promise<Cluster | null> {
    const [row] = await db
      .select()
      .from(schema.clustersTable)
      .where(eq(schema.clustersTable.id, id));
    return row ?? null;
  }

  static async getDefault(): Promise<Cluster> {
    const [row] = await db
      .select()
      .from(schema.clustersTable)
      .where(eq(schema.clustersTable.isDefault, true));

    if (!row) {
      throw new Error(
        "default cluster row missing — seed must run before this call",
      );
    }
    return row;
  }

  static async getPersonalDefault(): Promise<Cluster | null> {
    const [row] = await db
      .select()
      .from(schema.clustersTable)
      .where(eq(schema.clustersTable.isPersonalDefault, true));
    return row ?? null;
  }

  static async create(input: InsertClusterInput): Promise<Cluster> {
    if ("isDefault" in input) {
      throw new Error(
        "cannot set isDefault on cluster create — the default cluster is seeded by the system",
      );
    }

    const parsed = InsertClusterInputSchema.parse(input);

    if (parsed.kubeconfigYaml) {
      validateKubeconfigContent(parsed.kubeconfigYaml);
    }

    return await db.transaction(async (tx) => {
      let kubeconfigSecretId: string | null = null;
      if (parsed.kubeconfigYaml) {
        const secret = await SecretModel.create(
          {
            name: `cluster-kubeconfig:${parsed.name}`,
            secret: { [KUBECONFIG_SECRET_KEY]: parsed.kubeconfigYaml },
          },
          { tx },
        );
        kubeconfigSecretId = secret.id;
      }

      const values = {
        name: parsed.name,
        namespace: parsed.namespace ?? null,
        kubeconfigSecretId,
        loadFromCluster: parsed.loadFromCluster ?? false,
        isPersonalDefault: parsed.isPersonalDefault ?? false,
      };

      if (values.isPersonalDefault) {
        await tx
          .update(schema.clustersTable)
          .set({ isPersonalDefault: false })
          .where(eq(schema.clustersTable.isPersonalDefault, true));
      }

      const [created] = await tx
        .insert(schema.clustersTable)
        .values(values)
        .returning();
      return created;
    });
  }

  static async update(id: string, patch: UpdateClusterInput): Promise<Cluster> {
    if ("isDefault" in patch) {
      throw new Error(
        "cannot change isDefault on a cluster — the default flag is owned by the seed",
      );
    }

    const parsed = UpdateClusterInputSchema.parse(patch);

    if (
      typeof parsed.kubeconfigYaml === "string" &&
      parsed.kubeconfigYaml.length > 0
    ) {
      validateKubeconfigContent(parsed.kubeconfigYaml);
    }

    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.clustersTable)
        .where(eq(schema.clustersTable.id, id));
      if (!existing) {
        throw new Error(`cluster ${id} not found`);
      }

      let kubeconfigSecretIdPatch: {
        kubeconfigSecretId: string | null;
      } | null = null;

      const newSecretName =
        parsed.name !== undefined
          ? `cluster-kubeconfig:${parsed.name}`
          : undefined;

      if (parsed.kubeconfigYaml === null) {
        if (existing.kubeconfigSecretId) {
          await SecretModel.delete(existing.kubeconfigSecretId, { tx });
        }
        kubeconfigSecretIdPatch = { kubeconfigSecretId: null };
      } else if (
        typeof parsed.kubeconfigYaml === "string" &&
        parsed.kubeconfigYaml.length > 0
      ) {
        if (existing.kubeconfigSecretId) {
          await SecretModel.update(
            existing.kubeconfigSecretId,
            {
              secret: { [KUBECONFIG_SECRET_KEY]: parsed.kubeconfigYaml },
              ...(newSecretName ? { name: newSecretName } : {}),
            },
            { tx },
          );
        } else {
          const secret = await SecretModel.create(
            {
              name: `cluster-kubeconfig:${parsed.name ?? existing.name}`,
              secret: { [KUBECONFIG_SECRET_KEY]: parsed.kubeconfigYaml },
            },
            { tx },
          );
          kubeconfigSecretIdPatch = { kubeconfigSecretId: secret.id };
        }
      } else if (
        newSecretName !== undefined &&
        existing.kubeconfigSecretId !== null
      ) {
        await SecretModel.update(
          existing.kubeconfigSecretId,
          { name: newSecretName },
          { tx },
        );
      }

      const dbPatch: Partial<typeof schema.clustersTable.$inferInsert> = {};
      if (parsed.name !== undefined) dbPatch.name = parsed.name;
      if (parsed.namespace !== undefined)
        dbPatch.namespace = parsed.namespace ?? null;
      if (parsed.loadFromCluster !== undefined)
        dbPatch.loadFromCluster = parsed.loadFromCluster;
      if (parsed.isPersonalDefault !== undefined)
        dbPatch.isPersonalDefault = parsed.isPersonalDefault;
      if (kubeconfigSecretIdPatch) {
        dbPatch.kubeconfigSecretId = kubeconfigSecretIdPatch.kubeconfigSecretId;
      }

      if (parsed.isPersonalDefault === true) {
        await tx
          .update(schema.clustersTable)
          .set({ isPersonalDefault: false })
          .where(
            and(
              eq(schema.clustersTable.isPersonalDefault, true),
              ne(schema.clustersTable.id, id),
            ),
          );
      }

      if (Object.keys(dbPatch).length === 0) {
        return existing;
      }

      const [updated] = await tx
        .update(schema.clustersTable)
        .set(dbPatch)
        .where(eq(schema.clustersTable.id, id))
        .returning();
      return updated;
    });
  }

  static async delete(id: string): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.clustersTable)
        .where(eq(schema.clustersTable.id, id));
      if (!existing) return false;

      if (existing.isDefault) {
        throw new Error("cannot delete the default cluster");
      }

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.clusterId, id));

      if (count > 0) {
        throw new ClusterInUseError(id, count);
      }

      if (existing.kubeconfigSecretId) {
        await SecretModel.delete(existing.kubeconfigSecretId, { tx });
      }

      await tx
        .delete(schema.clustersTable)
        .where(eq(schema.clustersTable.id, id));
      return true;
    });
  }
}

export default ClusterModel;
