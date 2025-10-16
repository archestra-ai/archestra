import { env } from "next-runtime-env";
import type { CreateClientConfig } from "./client.gen";

/**
 * NOTE: we have this here because we need to support setting the baseUrl of the API client AT RUNTIME
 * (see https://github.com/expatfile/next-runtime-env)
 */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL") || "http://localhost:9000",
  credentials: "include",
});
