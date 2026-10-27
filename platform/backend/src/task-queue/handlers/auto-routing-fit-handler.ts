import { z } from "zod";
import { fitNow } from "@/auto-routing/fit";
import config from "@/config";
import logger from "@/logging";

export async function handleAutoRoutingFit(
  payload: Record<string, unknown>,
): Promise<void> {
  const { organizationId } = FitPayloadSchema.parse(payload);
  if (!config.autoRouting.enabled) return;
  // Refits a fit rejected for newer settings, so the generation that queued it gets an outcome.
  const run = await fitNow(organizationId);
  if (!run) {
    logger.info(
      { organizationId },
      "[AutoRouting] Auto routing is not configured; skipping the plan fit",
    );
    return;
  }
  logger.info(
    { organizationId, status: run.fit.status },
    "[AutoRouting] Plan fit recorded",
  );
}

const FitPayloadSchema = z.object({ organizationId: z.string().min(1) });
