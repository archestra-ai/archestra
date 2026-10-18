import InteractionUserActivityModel from "@/models/interaction-user-activity";
import type { TaskHandler } from "@/types";

export const handleInteractionUserActivityRebuild: TaskHandler = async () => {
  const state = await InteractionUserActivityModel.state();
  if (!state.enabled || state.ready) return;
  const deadline = Date.now() + 5000;
  for (let batch = 0; batch < 10; batch++) {
    const result = await InteractionUserActivityModel.rebuildBatch({
      batchSize: 100,
    });
    if (result.ready || Date.now() >= deadline) return;
  }
};
