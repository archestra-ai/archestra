import type { CreateClientConfig } from "./client.gen";

export const createClientConfig: CreateClientConfig = (config) => {
  return {
    ...config,
    // this is nextjs rewrite that proxies requests to https://registry.modelcontextprotocol.io
    baseUrl: "http://localhost:3000/api/mcp-registry-proxy",
    credentials: "include",
    throwOnError: true,
  };
};
