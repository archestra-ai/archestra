import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";

/**
 * Seeds the default cluster row on app boot. Idempotent and race-safe.
 *
 * The default row is stored with kubeconfigSecretId = null; the runtime
 * cluster-registry recognizes it by `is_default = true` and falls back to
 * reading kubeconfig + namespace from env vars (config.orchestrator.kubernetes).
 */
export async function seedDefaultCluster() {
  const { namespace, loadKubeconfigFromCurrentCluster } =
    config.orchestrator.kubernetes;

  const [inserted] = await db
    .insert(schema.clustersTable)
    .values({
      name: "default",
      namespace: namespace || null,
      kubeconfigSecretId: null,
      loadFromCluster: loadKubeconfigFromCurrentCluster,
      isDefault: true,
      isPersonalDefault: false,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    logger.info({ clusterId: inserted.id }, "Seeded default cluster");
    return inserted;
  }

  const [existing] = await db
    .select()
    .from(schema.clustersTable)
    .where(eq(schema.clustersTable.isDefault, true));

  return existing;
}
