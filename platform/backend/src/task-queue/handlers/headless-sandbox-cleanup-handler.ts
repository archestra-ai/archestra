import config from "@/config";
import logger from "@/logging";
import { SkillSandboxModel } from "@/models";

const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export async function handleHeadlessSandboxCleanup(): Promise<void> {
  const { headlessRetentionDays } = config.skillsSandbox;
  if (headlessRetentionDays === 0) {
    return;
  }

  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const removed = await SkillSandboxModel.deleteStaleHeadless({
      retentionDays: headlessRetentionDays,
      batchSize: BATCH_SIZE,
    });
    deleted += removed;
    if (removed < BATCH_SIZE) {
      break;
    }
  }

  logger.info(
    { deleted, headlessRetentionDays },
    "headless sandbox retention sweep: complete",
  );
}
