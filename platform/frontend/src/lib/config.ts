import { env } from "next-runtime-env";

export const getProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const envVarProxyUrl = env("NEXT_PUBLIC_ARCHESTRA_API_BASE_URL");

  if (!envVarProxyUrl) {
    return `http://localhost:9000${proxyUrlSuffix}`;
  } else if (envVarProxyUrl.endsWith(proxyUrlSuffix)) {
    return envVarProxyUrl;
  } else if (envVarProxyUrl.endsWith("/")) {
    return `${envVarProxyUrl.slice(0, -1)}${proxyUrlSuffix}`;
  }
  return `${envVarProxyUrl}${proxyUrlSuffix}`;
};

export default {
  api: {
    proxyUrl: getProxyUrl(),
  },
};
