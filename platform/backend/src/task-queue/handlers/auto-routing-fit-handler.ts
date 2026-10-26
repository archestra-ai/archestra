import { z } from "zod";
import { completeFit, prepareFit } from "@/auto-routing/fit";
import config from "@/config";
import logger from "@/logging";

export async function handleAutoRoutingFit(
  payload: Record<string, unknown>,
): Promise<void> {
  const { organizationId } = FitPayloadSchema.parse(payload);
  if (!config.autoRouting.enabled) return;
  const inputs = await prepareFit(organizationId);
  if (!inputs) {
    logger.info(
      { organizationId },
      "[AutoRouting] Auto routing is not configured; skipping the plan fit",
    );
    return;
  }
  const result = await completeFit(inputs);
  logger.info(
    {
      organizationId,
      trigger: inputs.trigger,
      status: result.plan.status,
      ...(result.kind === "rejected" && { rejected: result.reason }),
    },
    "[AutoRouting] Plan fit recorded",
  );
}

const FitPayloadSchema = z.object({ organizationId: z.string().min(1) });
