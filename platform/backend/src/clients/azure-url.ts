export function buildAzureDeploymentsUrl(params: {
  apiVersion: string;
  baseUrl: string;
}): string | null {
  try {
    const url = new URL(params.baseUrl);
    const pathname = url.pathname.replace(/\/[^/]+\/?$/, "");
    return `${url.origin}${pathname}?api-version=${params.apiVersion}`;
  } catch {
    return null;
  }
}

export function createAzureFetchWithApiVersion(params: {
  apiVersion: string;
  fetch?: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(getRequestUrl(input));
    url.searchParams.set("api-version", params.apiVersion);

    const fetchFn = params.fetch ?? globalThis.fetch;
    return fetchFn(url.toString(), init);
  };
}

export function normalizeAzureApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) {
    return apiKey;
  }

  return apiKey.replace(/^Bearer\s+/i, "");
}

function getRequestUrl(input: URL | RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}
