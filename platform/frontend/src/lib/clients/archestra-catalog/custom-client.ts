import type { CreateClientConfig } from "./client.gen";

/**
 * All requests go through Next.js rewrites (both local and production).
 */
export const createClientConfig: CreateClientConfig = (config) => {
  return {
    ...config,
    // this is nextjs rewrite that proxies requests to https://registry.modelcontextprotocol.io
    baseUrl: "http://localhost:3000/api/archestra-catalog",
    credentials: "include",
    throwOnError: true,
  };
};
