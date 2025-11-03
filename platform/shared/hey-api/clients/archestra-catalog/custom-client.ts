import type { CreateClientConfig } from "./client.gen";


export const createClientConfig: CreateClientConfig = (config) => {
  const isBrowser = typeof window !== "undefined";
  return {
    ...config,
    // In browser we go through nextjs rewrite that proxies requests to https://registry.modelcontextprotocol.io
    // to avoid CORS issues
    baseUrl: isBrowser
      ? "/api/archestra-catalog"
      : "https://www.archestra.ai/mcp-catalog/api",
    credentials: "include",
    throwOnError: true,
  };
};
