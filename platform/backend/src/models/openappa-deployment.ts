import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

const deployments = schema.openappaDeploymentsTable;
const revisions = schema.openappaPolicyRevisionsTable;

/**
 * The policy revision the runtime serves each organization: the head of the
 * deployment line named by the organization's id. The runtime's binding moves
 * the head when it publishes; the host only reads it.
 */
class OpenAppaDeploymentModel {
  /** The organization's current revision and when it was published, if any. */
  static async head(
    organizationId: string,
  ): Promise<{ revision: number; publishedAt: Date } | null> {
    const [row] = await db
      .select({
        revision: deployments.head,
        publishedAt: revisions.publishedAt,
      })
      .from(deployments)
      .innerJoin(
        revisions,
        and(
          eq(revisions.deployment, deployments.name),
          eq(revisions.revision, deployments.head),
        ),
      )
      .where(eq(deployments.name, organizationId));
    return row ?? null;
  }
}

export default OpenAppaDeploymentModel;
