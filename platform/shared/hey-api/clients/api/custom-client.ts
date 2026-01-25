import { createQuerySerializer } from "./client/utils.gen";
import type { CreateClientConfig } from "./client.gen";

/**
 * Custom query serializer that uses comma-separated arrays instead of repeated params.
 * Backend expects: agentTypes=llm_proxy,profile
 * NOT: agentTypes=llm_proxy&agentTypes=profile
 */
const querySerializer = createQuerySerializer({
  allowReserved: false,
  array: {
    explode: false, // Use comma-separated format: name=a,b,c
    style: "form",
  },
  object: {
    explode: true,
    style: "deepObject",
  },
});

/**
 * All requests go through Next.js rewrites (both local and production).
 * - Client-side: Use relative URLs (e.g., /api/agents)
 * - Server-side: Use absolute backend URL from ARCHESTRA_INTERNAL_API_BASE_URL env var
 */
export const createClientConfig: CreateClientConfig = (config) => {
  const isServer = typeof window === "undefined";

  const backendUrl =
    process.env.ARCHESTRA_INTERNAL_API_BASE_URL || "http://localhost:9000";

  return {
    ...config,
    baseUrl: isServer ? backendUrl : "",
    credentials: "include",
    // Set to false to let React Query handle errors gracefully instead of throwing exceptions
    // that crash the app (especially important for 403 errors during auth checks)
    throwOnError: false,
    querySerializer,
  };
};
