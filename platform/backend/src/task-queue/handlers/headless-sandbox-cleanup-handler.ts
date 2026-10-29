import config from "@/config";
import logger from "@/logging";
import { SkillSandboxModel } from "@/models";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const MAX_BATCHES = 20;

export async function handleHeadlessSandboxCleanup(): Promise<void> {
  const { headlessRetentionDays } = config.skillsSandbox;
  if (headlessRetentionDays === 0) {
    return;
  }

  const olderThan = new Date(Date.now() - headlessRetentionDays * DAY_MS);
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const removed = await SkillSandboxModel.deleteStaleHeadless({
      olderThan,
      batchSize: BATCH_SIZE,
    });
    deleted += removed;
    if (removed < BATCH_SIZE) {
      break;
    }
  }

  logger.info(
    { deleted, headlessRetentionDays, olderThan: olderThan.toISOString() },
    "headless sandbox retention sweep: complete",
  );
}
