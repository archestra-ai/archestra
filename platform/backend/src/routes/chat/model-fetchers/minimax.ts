import { MINIMAX_MODELS } from "@archestra/shared";
import type { ModelInfo } from "./types";

export async function fetchMinimaxModels(): Promise<ModelInfo[]> {
  return MINIMAX_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: "minimax",
  }));
}
