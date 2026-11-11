import { z } from "zod";
import { fitNow } from "@/auto-routing/fit";
import config from "@/config";
import logger from "@/logging";

export async function handleAutoRoutingFit(
  payload: Record<string, unknown>,
): Promise<void> {
  const { routerId } = FitPayloadSchema.parse(payload);
  if (!config.autoRouting.enabled) return;
  // Refits a fit rejected for newer settings, so the generation that queued it gets an outcome.
  const run = await fitNow(routerId);
  if (!run) {
    logger.info(
      { routerId },
      "[AutoRouting] The auto router is not configured; skipping the plan fit",
    );
    return;
  }
  logger.info(
    { routerId, status: run.fit.status },
    "[AutoRouting] Plan fit recorded",
  );
}

const FitPayloadSchema = z.object({ routerId: z.string().min(1) });
