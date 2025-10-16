import { env } from "next-runtime-env";

const getEnvVarApiBaseUrl = () => env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");

export const getProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const envVarApiBaseUrl = getEnvVarApiBaseUrl();

  if (!envVarApiBaseUrl) {
    return `http://localhost:9000${proxyUrlSuffix}`;
  } else if (envVarApiBaseUrl.endsWith(proxyUrlSuffix)) {
    return envVarApiBaseUrl;
  } else if (envVarApiBaseUrl.endsWith("/")) {
    return `${envVarApiBaseUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${envVarApiBaseUrl}${proxyUrlSuffix}`;
};

export default {
  api: {
    proxyUrl: getProxyUrl(),
    baseUrl: getEnvVarApiBaseUrl() || "http://localhost:9000",
  },
  debug: process.env.NODE_ENV !== "production",
};
