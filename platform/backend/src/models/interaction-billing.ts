import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { AttributionLabels } from "@/types/attribution-label";
import type {
  BillingAttribution,
  PricedBillingUsage,
} from "@/utils/billable-usage";

/** Receipts are independent of log content, encryption and retention. */
export default class InteractionBillingModel {
  static async claim(params: {
    tx: Transaction;
    interactionId: string;
    usage: PricedBillingUsage;
    attribution: BillingAttribution;
    userId: string | null;
    billingTeamId: string | null;
    billingMode: string;
    attributionLabels?: AttributionLabels | null;
    logIdentity?: {
      profileId: string | null;
      appId: string | null;
      connectorId: string | null;
      serviceAccountId: string | null;
    };
  }): Promise<boolean> {
    const {
      tx,
      interactionId,
      usage,
      attribution,
      userId,
      billingTeamId,
      billingMode,
    } = params;
    // Prices may change between an ambiguous commit and its retry. Identity is
    // based on provider counts and admission attribution, never a new quote.
    // logIdentity uses admitted IDs, not the nullable log columns repaired on
    // an FK retry; deleting a log reference must not change receipt identity.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: usage.version,
          mode: usage.mode,
          providerIssues: [
            ...new Set(
              usage.issues.filter(
                (issue) =>
                  !["estimated_model_price", "unpriced_usage"].includes(issue),
              ),
            ),
          ].sort(),
          components: usage.components.map((item) => ({
            id: item.id,
            model: item.model,
            provider: item.provider,
            kind: item.kind,
            inputTokens: item.inputTokens,
            outputTokens: item.outputTokens,
            cacheReadTokens: item.cacheReadTokens,
            cacheWriteTokens: item.cacheWriteTokens,
            cacheWrite1hTokens: item.cacheWrite1hTokens,
            ...(item.prices.source === "provider"
              ? { providerCost: item.cost }
              : {}),
          })),
          organizationId: attribution.organizationId,
          environmentId: attribution.environmentId,
          entities: attribution.entities
            .map(({ entityType, entityId }) => ({ entityType, entityId }))
            .sort((a, b) =>
              `${a.entityType}:${a.entityId}`.localeCompare(
                `${b.entityType}:${b.entityId}`,
              ),
            ),
          userId,
          billingTeamId,
          billingMode,
          logIdentity: params.logIdentity,
        }),
      )
      .digest("hex");
    const [claimed] = await tx
      .insert(schema.interactionBillingTable)
      .values({
        interactionId,
        fingerprint,
        usage,
        organizationId: attribution.organizationId,
        environmentId: attribution.environmentId,
        userId,
        billingTeamId,
        billingMode,
        // First settlement owns the snapshot; mutable labels are deliberately
        // excluded from the billing identity used to recognize retries.
        attributionLabels: params.attributionLabels,
      })
      .onConflictDoNothing()
      .returning({ id: schema.interactionBillingTable.interactionId });
    if (claimed) return true;
    const [existing] = await tx
      .select()
      .from(schema.interactionBillingTable)
      .where(eq(schema.interactionBillingTable.interactionId, interactionId));
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new Error(
        "Interaction billing identity conflicts with an existing settlement",
      );
    }
    return false;
  }

  static async findMany(ids: string[]) {
    if (!ids.length) return [];
    return db
      .select()
      .from(schema.interactionBillingTable)
      .where(inArray(schema.interactionBillingTable.interactionId, ids));
  }
}
