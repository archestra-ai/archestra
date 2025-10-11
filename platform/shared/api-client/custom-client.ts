import type { CreateClientConfig } from './client.gen';

export const createClientConfig: CreateClientConfig = (clientConfig) => ({
  ...clientConfig,
  baseUrl: process.env.NEXT_PUBLIC_ARCHESTRA_API_BASE_URL,
});
