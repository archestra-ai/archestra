import { PERPLEXITY_MODELS } from "@shared";
import type { ModelInfo } from "./types";

export async function fetchPerplexityModels(): Promise<ModelInfo[]> {
  return PERPLEXITY_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: "perplexity",
  }));
}
