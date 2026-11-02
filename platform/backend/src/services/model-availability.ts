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
  /** Equivalent spellings supplied only by a trusted endpoint resolver. */
  aliases?: string[];
}): Promise<void> {
  const modelId = stripClaudeContextVariantSuffix(params.modelId);
  // Read current state, not a cached catalog or the request's admission snapshot:
  // a request may have waited for throughput or for another pool member.
  const models = await ModelModel.findByProviderModelIds(
    [...new Set([modelId, ...(params.aliases ?? [])])].map((id) => ({
      provider: params.provider,
      modelId: id,
    })),
  );
  const hidden = [...models.values()].find((model) => model.ignored);
  if (hidden) {
    throw new ApiError(
      403,
      `Model ${hidden.modelId} is hidden and cannot be used. Show the model in the model catalog to enable it.`,
      "model_hidden",
    );
  }
}
