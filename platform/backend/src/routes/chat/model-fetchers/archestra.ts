import { makeBearerFetcher } from "./bearer-fetcher";

/**
 * The "archestra" provider targets another Archestra instance's OpenAI-
 * compatible LLM proxy. Model listing hits `{baseUrl}/models` (the upstream
 * Archestra proxy exposes an OpenAI-shaped model list) with the configured
 * Archestra API key. The base URL is always the per-key override, so no global
 * default is required.
 */
export const fetchArchestraModels = makeBearerFetcher<{
  id: string;
  created?: number;
}>({
  provider: "archestra",
  configKey: "archestra",
  // white-label-ok: names the `archestra` upstream LLM provider a deployment connects to, not this deployment's own brand
  errorLabel: "Archestra models",
});
