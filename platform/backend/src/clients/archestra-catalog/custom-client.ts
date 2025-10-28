import type { CreateClientConfig } from "./client.gen";

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: "https://www.archestra.ai/mcp-catalog/api",
});
