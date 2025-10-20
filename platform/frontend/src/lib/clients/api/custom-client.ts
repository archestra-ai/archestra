import { env } from "next-runtime-env";
import type { CreateClientConfig } from "./client.gen";

/**
 * We use different baseUrls depending on the environment:
 * - Server-side (Next.js Server Components): Use absolute URL to backend (http://localhost:9000)
 * - Client-side (browser): Use empty baseUrl for relative URLs that go through Next.js rewrites
 */
export const createClientConfig: CreateClientConfig = (config) => {
  const isServer = typeof window === "undefined";
  const backendUrl =
    env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL") || "http://localhost:9000";

  return {
    ...config,
    baseUrl: isServer ? backendUrl : "",
    credentials: "include",
    throwOnError: true,
  };
};
