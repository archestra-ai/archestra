export function buildAzureDeploymentsUrl(params: {
  apiVersion: string;
  baseUrl: string;
}): string | null {
  try {
    const url = new URL(params.baseUrl);
    if (isAzureOpenAiV1Url(url)) {
      // Foundry v1 endpoints use /openai/v1/models instead of deployment discovery.
      return null;
    }

    const pathname = getAzureDeploymentsPathname(url);
    if (!pathname) {
      return null;
    }

    return `${url.origin}${pathname}?api-version=${params.apiVersion}`;
  } catch {
    return null;
  }
}

export function buildAzureOpenAiV1ModelsUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!isAzureOpenAiV1Url(url)) {
      return null;
    }

    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/models`;
  } catch {
    return null;
  }
}

export function buildAzureResponsesBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (isAzureOpenAiV1Url(url)) {
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }

    const pathname = getAzureOpenAiPathname(url);
    if (!pathname) {
      return null;
    }

    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function buildAzureDeploymentBaseUrl(params: {
  baseUrl: string | undefined;
  deploymentName: string;
}): string | null {
  if (!params.baseUrl) {
    return null;
  }

  try {
    const url = new URL(params.baseUrl);
    if (isAzureOpenAiV1Url(url)) {
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }

    if (/\/openai\/deployments\/[^/]+\/?$/.test(url.pathname)) {
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }

    const openAiPathname = getAzureOpenAiPathname(url);
    if (!openAiPathname) {
      return null;
    }

    return `${url.origin}${openAiPathname}/deployments/${encodeURIComponent(params.deploymentName)}`;
  } catch {
    return null;
  }
}

export function extractAzureDeploymentName(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? null;
  } catch {
    return null;
  }
}

export function shouldUseAzureOpenAiApiVersion(baseUrl: string | undefined) {
  if (!baseUrl) {
    return true;
  }

  try {
    return !isAzureOpenAiV1Url(new URL(baseUrl));
  } catch {
    return true;
  }
}

export function isAzureOpenAiV1BaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    return isAzureOpenAiV1Url(new URL(baseUrl));
  } catch {
    return false;
  }
}

export function isAzureAiFoundryBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === "ai.azure.com" || url.hostname.endsWith(".ai.azure.com")
    );
  } catch {
    return false;
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

export function normalizeAzureApiKey(
  apiKey: string | undefined,
): string | undefined {
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

function isAzureOpenAiV1Url(url: URL): boolean {
  return /\/openai\/v1\/?$/.test(url.pathname);
}

function getAzureDeploymentsPathname(url: URL): string | null {
  const pathname = url.pathname.replace(/\/+$/, "");

  if (/\/openai\/deployments\/[^/]+$/.test(pathname)) {
    return pathname.replace(/\/[^/]+$/, "");
  }

  if (/\/openai\/deployments$/.test(pathname)) {
    return pathname;
  }

  if (/\/openai$/.test(pathname)) {
    return `${pathname}/deployments`;
  }

  return null;
}

function getAzureOpenAiPathname(url: URL): string | null {
  const pathname = url.pathname.replace(/\/+$/, "");

  if (/\/openai\/deployments\/[^/]+$/.test(pathname)) {
    return pathname.replace(/\/deployments\/[^/]+$/, "");
  }

  if (/\/openai\/deployments$/.test(pathname)) {
    return pathname.replace(/\/deployments$/, "");
  }

  if (/\/openai$/.test(pathname)) {
    return pathname;
  }

  return null;
}
