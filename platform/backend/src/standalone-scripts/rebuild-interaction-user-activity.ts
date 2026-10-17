import { parseArgs } from "node:util";
import db, { initializeDatabase } from "@/database";
import logger from "@/logging";
import InteractionUserActivityModel from "@/models/interaction-user-activity";

const { values } = parseArgs({
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
if (!Number.isInteger(maxBatches) || maxBatches < 1)
  throw new Error("max-batches must be positive");
await initializeDatabase();
try {
  if (values.invalidate) await InteractionUserActivityModel.invalidate();
  if (values.enable && values.disable)
    throw new Error("Choose --enable or --disable, not both");
  if (values.enable) await InteractionUserActivityModel.setEnabled(true);
  if (values.disable) await InteractionUserActivityModel.setEnabled(false);
  if (!(await InteractionUserActivityModel.state()).enabled) {
    logger.info(
      "Summary is disabled; after ALL writers are upgraded, run with --enable.",
    );
  } else {
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await InteractionUserActivityModel.rebuildBatch({
        batchSize,
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
      process.exitCode = 2;
    }
  }
} finally {
  await db.$client.end();
}
