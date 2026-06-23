import { makeBearerFetcher, mapKeylessModel } from "./bearer-fetcher";

export const fetchOllamaModels = makeBearerFetcher<{
  id: string;
  created?: number;
}>({
  provider: "ollama",
  configKey: "ollama",
  errorLabel: "Ollama models",
  placeholderToken: true,
  mapModel: mapKeylessModel,
});
