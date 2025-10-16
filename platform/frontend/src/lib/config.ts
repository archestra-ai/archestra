import { env } from "next-runtime-env";

const envVarApiBaseUrl = env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");

export const getProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const baseUrl = env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");

  if (!baseUrl) {
    return `http://localhost:9000${proxyUrlSuffix}`;
  } else if (baseUrl.endsWith(proxyUrlSuffix)) {
    return baseUrl;
  } else if (baseUrl.endsWith("/")) {
    return `${baseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${baseUrl}${proxyUrlSuffix}`;
};

export default {
  api: {
    proxyUrl: getProxyUrl(),
    baseUrl: envVarApiBaseUrl || "http://localhost:9000",
  },
  debug: process.env.NODE_ENV !== "production",
};
