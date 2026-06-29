import { makeBearerFetcher, mapKeylessModel } from "./bearer-fetcher";

export const fetchVllmModels = makeBearerFetcher<{
  id: string;
  created?: number;
}>({
  provider: "vllm",
  configKey: "vllm",
  errorLabel: "vLLM models",
  placeholderToken: true,
  mapModel: mapKeylessModel,
});
