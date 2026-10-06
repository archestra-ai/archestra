import { makeStaticFetcher } from "./bearer-fetcher";

/**
 * Jev publishes no model-listing endpoint, so the catalog is static. These are
 * decision models: the provider is decisions-only, so no chat picker offers
 * them (see `providerSupportsChat`).
 */
export const fetchJevModels = makeStaticFetcher("jev", [
  { id: "jev-1.13.0", displayName: "Jev 1.13" },
]);
