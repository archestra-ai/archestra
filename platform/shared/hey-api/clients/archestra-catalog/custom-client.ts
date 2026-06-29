import { MCP_CATALOG_API_BASE_URL } from "../../../consts";
import type { CreateClientConfig } from "./client.gen";

export const createClientConfig: CreateClientConfig = (config) => {
  const isBrowser = typeof window !== "undefined";
  return {
    ...config,
    // In browser we go through nextjs rewrite that proxies requests to https://archestra.ai/mcp-catalog/api
    // to avoid CORS issues
    baseUrl: isBrowser ? "/api/archestra-catalog" : MCP_CATALOG_API_BASE_URL,
    credentials: "include",
    throwOnError: true,
  };
};
