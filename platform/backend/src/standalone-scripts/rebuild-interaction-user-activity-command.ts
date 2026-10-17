import { parseArgs } from "node:util";
import logger from "@/logging";
import InteractionUserActivityModel from "@/models/interaction-user-activity";

export function parseInteractionUserActivityArguments(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      invalidate: { type: "boolean", default: false },
      enable: { type: "boolean", default: false },
      disable: { type: "boolean", default: false },
      "batch-size": { type: "string", default: "100" },
      "max-batches": { type: "string", default: "100" },
    },
  });
  const batchSize = Number(values["batch-size"]);
  const maxBatches = Number(values["max-batches"]);
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1)
    throw new Error("max-batches must be positive");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Batch size must be 1..1000");
  if (values.enable && values.disable)
    throw new Error("Choose --enable or --disable, not both");
  return { ...values, batchSize, maxBatches };
}

export async function rebuildInteractionUserActivityCommand(
  options: ReturnType<typeof parseInteractionUserActivityArguments>,
): Promise<0 | 2> {
  if (options.invalidate) await InteractionUserActivityModel.invalidate();
  if (options.enable) await InteractionUserActivityModel.setEnabled(true);
  if (options.disable) await InteractionUserActivityModel.setEnabled(false);
  if (!(await InteractionUserActivityModel.state()).enabled) {
    logger.info(
      "Summary is disabled; after ALL writers are upgraded, run with --enable.",
    );
    return 0;
  }
  for (let batch = 0; batch < options.maxBatches; batch++) {
    const result = await InteractionUserActivityModel.rebuildBatch({
      batchSize: options.batchSize,
    });
    logger.info(
      { batch: batch + 1, ...result },
      "Interaction user activity rebuild",
    );
    if (result.ready) break;
  }
  if (!(await InteractionUserActivityModel.state()).ready) {
    logger.warn(
      "Rebuild incomplete; rerun without --invalidate to resume. Exact fallback remains active.",
    );
    return 2;
  }
  return 0;
}
