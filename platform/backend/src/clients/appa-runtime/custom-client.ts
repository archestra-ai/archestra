import type { CreateClientConfig } from "./generated/client.gen";

/** The domain client always supplies its validated runtime endpoint. */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  throwOnError: false,
});
