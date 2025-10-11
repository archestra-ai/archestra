export const PROXY_URL_ENV_VAR_NAME = "NEXT_PUBLIC_ARCHESTRA_API_BASE_URL";

export const getProxyUrl = (): string => {
  const proxyUrlSuffix = "/v1";
  const envVarProxyUrl = process.env[PROXY_URL_ENV_VAR_NAME];

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
