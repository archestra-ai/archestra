import type { CreateClientConfig } from './client.gen';

export const createClientConfig: CreateClientConfig = (clientConfig) => ({
  ...clientConfig,
  baseUrl: process.env.ARCHESTRA_API_BASE_URL,
});
