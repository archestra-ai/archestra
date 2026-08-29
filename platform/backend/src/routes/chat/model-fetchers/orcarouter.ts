import { makeBearerFetcher } from "./bearer-fetcher";

/**
 * OrcaRouter exposes a standard OpenAI-compatible `/models` endpoint listing
 * both the vendor-prefixed model catalog and its built-in routers
 * (`orcarouter/auto`, `orcarouter/free`).
 */
export const fetchOrcaRouterModels = makeBearerFetcher({
  provider: "orcarouter",
  configKey: "orcarouter",
  errorLabel: "OrcaRouter models",
});
