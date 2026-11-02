import {
  type SupportedProvider,
  stripClaudeContextVariantSuffix,
} from "@archestra/shared";
import ModelModel from "@/models/model";
import { ApiError } from "@/types";

/** Check the resolved provider/model immediately before starting an execution. */
export async function assertModelAvailable(params: {
  provider: SupportedProvider;
  modelId: string;
}): Promise<void> {
  const modelId = stripClaudeContextVariantSuffix(params.modelId);
  // Read current state, not a cached catalog or the request's admission snapshot:
  // a request may have waited for throughput or for another pool member.
  const model = await ModelModel.findByProviderAndModelId(
    params.provider,
    modelId,
  );
  if (model?.ignored) {
    throw new ApiError(
      403,
      `Model ${modelId} is hidden and cannot be used. Show the model in the model catalog to enable it.`,
      "model_hidden",
    );
  }
}
