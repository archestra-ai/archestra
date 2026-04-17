import type { OpenAi } from "@/types";
import type { ModelFetcher } from "./types";

/**
 * Returns an empty model list. 
 * The actual unified models aggregation logic is handled directly in the fastify route
 * by executing multiple provider fetches and merging them, since the fetcher signature
 * only takes a single API key instead of an organization's suite of keys.
 */
export const fetchUnifiedModels: ModelFetcher = async () => {
  return [];
};
