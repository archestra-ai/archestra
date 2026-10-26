import { and, eq, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import {
  lockRoutingPlan,
  organizationLlmProxy,
} from "@/models/auto-routing-settings";
import {
  type RoutingFit,
  type RoutingPlan,
  type RoutingPublishRejection,
  type RoutingPublishResult,
  SelectRoutingPlanSchema,
} from "@/types/auto-routing";

const plans = schema.routingPlansTable;
const agents = schema.agentsTable;

class RoutingPlanModel {
  static async findActive(organizationId: string): Promise<RoutingPlan | null> {
    const [row] = await db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.organizationId, organizationId),
          eq(plans.status, "active"),
        ),
      );
    return row ? SelectRoutingPlanSchema.parse(row) : null;
  }

  /**
   * Records a fit's outcome under the routing-plan lock. The fit loses — and is
   * recorded as failed — when settings changed since it read them or a fit over
   * newer usage already published. An `active` outcome supersedes the serving
   * plan and a `cold_start` retires it; a failure leaves it serving. Every
   * outcome marks its generation planned, so a failing fit does not hot-loop.
   */
  static async publish(fit: RoutingFit): Promise<RoutingPublishResult> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, fit.organizationId);
      const [settings] = await tx
        .select({ generation: agents.autoRoutingGeneration })
        .from(agents)
        .where(organizationLlmProxy(fit.organizationId));
      const [active] = await tx
        .select({ id: plans.id, inputWatermark: plans.inputWatermark })
        .from(plans)
        .where(
          and(
            eq(plans.organizationId, fit.organizationId),
            eq(plans.status, "active"),
          ),
        );
      const rejection: RoutingPublishRejection | null =
        settings?.generation !== fit.generation
          ? "stale_generation"
          : active && fit.inputWatermark < active.inputWatermark
            ? "stale_watermark"
            : null;
      const outcome = rejection
        ? {
            status: "failed" as const,
            error: `Rejected at publication: ${rejection}`,
            diagnostics: fit.outcome.diagnostics,
          }
        : fit.outcome;

      if (active && outcome.status !== "failed") {
        await tx
          .update(plans)
          .set({ status: "superseded" })
          .where(eq(plans.id, active.id));
      }
      const [row] = await tx
        .insert(plans)
        .values({
          organizationId: fit.organizationId,
          trigger: fit.trigger,
          generation: fit.generation,
          inputWatermark: fit.inputWatermark,
          tiersFingerprint: fit.tiersFingerprint,
          budgetUsdPerDay: fit.budgetUsdPerDay,
          scorerVersionId: fit.scorerVersionId,
          coreVersion: fit.coreVersion,
          planFormatVersion: fit.planFormatVersion,
          status: outcome.status,
          plan: outcome.status === "active" ? outcome.plan : null,
          summary: outcome.status === "failed" ? null : outcome.summary,
          diagnostics: outcome.diagnostics,
          error: outcome.status === "failed" ? outcome.error : null,
        })
        .returning();
      await tx
        .update(agents)
        .set({
          autoRoutingPlannedGeneration: sql`greatest(${agents.autoRoutingPlannedGeneration}, ${fit.generation})`,
        })
        .where(organizationLlmProxy(fit.organizationId));

      const plan = SelectRoutingPlanSchema.parse(row);
      return rejection
        ? { kind: "rejected", reason: rejection, plan }
        : { kind: "recorded", plan };
    });
  }
}

export default RoutingPlanModel;
