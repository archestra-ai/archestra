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

/**
 * Classic data-plane deployments URL for a Foundry v1 base URL.
 *
 * `/openai/v1/models` answers with the region's model CATALOG — every model the
 * resource *could* run — while Azure requires the request's `model` to be a
 * DEPLOYMENT name the user chose. Those namespaces don't overlap, so a v1
 * endpoint still has to ask the classic route what is actually deployed.
 */
export function buildAzureV1DeploymentsUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (!isAzureOpenAiV1Url(url)) {
      return null;
    }

    const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${url.origin}${pathname}/deployments?api-version=${AZURE_DEPLOYMENTS_API_VERSION}`;
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

export function buildAzureModelsUrl(params: {
  apiVersion: string;
  baseUrl: string;
}): string | null {
  try {
    const url = new URL(params.baseUrl);
    if (isAzureOpenAiV1Url(url)) {
      return null;
    }

    const pathname = getAzureOpenAiPathname(url);
    if (!pathname) {
      return null;
    }

    return `${url.origin}${pathname}/models?api-version=${params.apiVersion}`;
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
    const match = url.pathname.match(/\/openai\/deployments\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
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

/**
 * Whether an Azure deployment name denotes an OpenAI first-party model
 * (gpt-4o, gpt-5.x, o-series, ...) as opposed to a Foundry-hosted open model
 * (DeepSeek-R1, gpt-oss, grok, phi, ...). Deployment names are free-form, so
 * this is the same name heuristic @ai-sdk/openai itself applies. It decides
 * which AI SDK provider the chat feature builds for a deployment: first-party
 * reasoning models need @ai-sdk/openai's max_tokens → max_completion_tokens
 * conversion (they reject max_tokens), while open models need
 * @ai-sdk/openai-compatible so their `reasoning_content` deltas surface as
 * reasoning parts instead of being dropped by the strict parser.
 *
 * gpt-oss is the deliberate exception inside the gpt-* family: it is an
 * open-weight model that streams `reasoning_content`.
 */
export function isAzureOpenAiFirstPartyModelName(
  deploymentName: string,
): boolean {
  const name = deploymentName.toLowerCase();
  if (name.startsWith("gpt-oss")) {
    return false;
  }

  return (
    name.startsWith("gpt-") ||
    name.startsWith("o1") ||
    name.startsWith("o3") ||
    name.startsWith("o4") ||
    name.startsWith("chatgpt") ||
    name.startsWith("codex")
  );
}

/**
 * Whether an Azure deployment name denotes a model that produces separate
 * thinking output when asked for it.
 *
 * Foundry serves open models on vLLM, and a reasoning model only splits its
 * thinking into `reasoning_content` when the request carries
 * `reasoning_effort` — without it the thinking is narrated inline in
 * `content`, indistinguishable from the answer. Archestra therefore defaults
 * the parameter for these deployments.
 *
 * Deliberately an allowlist rather than "every non-OpenAI deployment": a
 * deployment whose backend does not accept `reasoning_effort` rejects the
 * whole request, so a family belongs here only once it is known to accept it.
 * DeepSeek (including Microsoft's R1 derivative) is verified; add others as
 * they are confirmed.
 */
export function isAzureThinkingModelName(deploymentName: string): boolean {
  const name = deploymentName.toLowerCase();
  return name.startsWith("deepseek") || name.startsWith("mai-ds");
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

/**
 * Deployment listing lives on the classic data plane, which newer api-versions
 * dropped — 2024-02-01 answers 404 Resource not found. It is therefore pinned
 * here instead of following `config.llm.azure.apiVersion`, which governs
 * inference and is the user's to choose.
 */
const AZURE_DEPLOYMENTS_API_VERSION = "2023-03-15-preview";

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
