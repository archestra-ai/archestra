import type { KubeConfig } from "@kubernetes/client-node";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface BuildProxyUrlInput {
  kubeApiHost: string;
  namespace: string;
  serviceName?: string;
  podName?: string;
  port: number;
  path: string;
}

export function buildProxyUrl(input: BuildProxyUrlInput): string {
  const host = input.kubeApiHost.replace(/\/+$/, "");
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  if (input.podName) {
    return `${host}/api/v1/namespaces/${input.namespace}/pods/${input.podName}:${input.port}/proxy${path}`;
  }
  if (!input.serviceName) {
    throw new Error("buildProxyUrl: either podName or serviceName must be set");
  }
  return `${host}/api/v1/namespaces/${input.namespace}/services/${input.serviceName}:${input.port}/proxy${path}`;
}

interface BuildProxyFetchInput {
  kubeConfig: KubeConfig;
}

/**
 * Build a fetch wrapper that authenticates each request with the cluster's
 * kubeconfig (auth header, TLS material, dispatcher/agent). The upstream MCP
 * server's `Authorization` header is dropped — when tunnelling through the
 * Kubernetes API server proxy the inner pod is reached via cluster-internal
 * trust, so the kubeconfig auth wins.
 *
 * The wrapper does NOT buffer the response — `StreamableHTTPClientTransport`
 * needs the streaming body intact for SSE.
 */
export function buildProxyFetch(input: BuildProxyFetchInput): FetchLike {
  const { kubeConfig } = input;

  return async (url, init = {}) => {
    const applied = (await kubeConfig.applyToFetchOptions({})) as RequestInit & {
      dispatcher?: unknown;
      agent?: unknown;
    };

    const merged = new Headers(init.headers ?? undefined);
    merged.delete("authorization");

    if (applied.headers) {
      const authHeaders = new Headers(applied.headers);
      authHeaders.forEach((value, key) => {
        merged.set(key, value);
      });
    }

    const finalInit: RequestInit & {
      dispatcher?: unknown;
      agent?: unknown;
    } = {
      ...init,
      headers: merged,
    };

    if (applied.dispatcher !== undefined) {
      finalInit.dispatcher = applied.dispatcher;
    }
    if (applied.agent !== undefined) {
      finalInit.agent = applied.agent;
    }

    return fetch(url as string | URL | Request, finalInit as RequestInit);
  };
}
