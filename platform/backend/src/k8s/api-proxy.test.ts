import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

/**
 * F3 — pure helpers around `K8sDeployment.httpEndpointDescriptor` /
 * Streamable-HTTP routing through the Kubernetes API server proxy.
 *
 * Module under test does not exist yet — RED phase. Each test imports the
 * helpers lazily and is expected to fail at runtime until `api-proxy.ts`
 * is added with `buildProxyUrl` and `buildProxyFetch` exports.
 *
 * Spec: platform/specs/cluster-fixes/F3-streamable-http-multi-cluster.md
 */

// --- Mock @kubernetes/client-node ----------------------------------------
// We cannot read api-proxy.ts (developer scope), so we mock the only
// runtime dependency: KubeConfig.applyToFetchOptions / getCurrentCluster.
vi.mock("@kubernetes/client-node", () => {
  class MockKubeConfig {
    clusters: Array<{ name: string; server: string }> = [];
    contexts: Array<{ name: string }> = [];
    users: Array<{ name: string }> = [];
    applyToFetchOptions = vi.fn();
    getCurrentCluster = vi.fn();
    loadFromString = vi.fn();
    loadFromCluster = vi.fn();
    loadFromFile = vi.fn();
    loadFromDefault = vi.fn();
    makeApiClient = vi.fn(() => ({}));
  }
  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: vi.fn(),
    AppsV1Api: vi.fn(),
    BatchV1Api: vi.fn(),
    Attach: vi.fn(),
    Log: vi.fn(),
    Exec: vi.fn(),
  };
});

vi.mock("@/logging", () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function importApiProxy() {
  // The file does not exist yet — these imports will throw with a runtime
  // module resolution error until F3 GREEN lands.
  const mod = await import("./api-proxy");
  return mod as unknown as {
    buildProxyUrl: (input: {
      kubeApiHost: string;
      namespace: string;
      serviceName: string;
      port: number;
      path: string;
      podName?: string;
    }) => string;
    buildProxyFetch: (input: { kubeConfig: k8s.KubeConfig }) => (
      input: URL | string,
      init?: RequestInit,
    ) => Promise<Response>;
  };
}

// Real fetch is replaced with a vi.fn for every test.
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("api-proxy.buildProxyUrl", () => {
  test("service-level proxy URL with numeric port and path", async () => {
    const { buildProxyUrl } = await importApiProxy();

    const url = buildProxyUrl({
      kubeApiHost: "https://kube.example.com:6443",
      namespace: "team-eu",
      serviceName: "mcp-foo-service",
      port: 8080,
      path: "/mcp",
    });

    expect(url).toBe(
      "https://kube.example.com:6443/api/v1/namespaces/team-eu/services/mcp-foo-service:8080/proxy/mcp",
    );
  });

  test("pod-level proxy URL when podName is provided", async () => {
    const { buildProxyUrl } = await importApiProxy();

    const url = buildProxyUrl({
      kubeApiHost: "https://kube.example.com:6443",
      namespace: "team-eu",
      serviceName: "mcp-foo-service",
      port: 8080,
      path: "/mcp",
      podName: "mcp-foo-abc123",
    });

    expect(url).toBe(
      "https://kube.example.com:6443/api/v1/namespaces/team-eu/pods/mcp-foo-abc123:8080/proxy/mcp",
    );
  });

  test("trims a trailing slash from kubeApiHost", async () => {
    const { buildProxyUrl } = await importApiProxy();

    const url = buildProxyUrl({
      kubeApiHost: "https://kube.example.com:6443/",
      namespace: "ns",
      serviceName: "svc",
      port: 80,
      path: "/mcp",
    });

    // No double slash before /api/v1 — exact form, host trimmed.
    expect(url).toBe(
      "https://kube.example.com:6443/api/v1/namespaces/ns/services/svc:80/proxy/mcp",
    );
  });
});

describe("api-proxy.buildProxyFetch", () => {
  type ApplyOpts = {
    headers?: Record<string, string> | Headers;
    // The k8s client-node library has historically populated either:
    //   - `agent` (legacy node-fetch / https.Agent style)
    //   - `dispatcher` (undici)
    // Either is acceptable here — the wrapper just needs to forward it.
    agent?: unknown;
    dispatcher?: unknown;
  };

  function makeMockKubeConfig(
    applyOpts: ApplyOpts,
    getCurrentClusterReturn: { server: string } | null = {
      server: "https://kube.example.com:6443",
    },
  ): k8s.KubeConfig {
    const kc = {
      applyToFetchOptions: vi.fn(async (init?: RequestInit) => {
        // Mirror the real behaviour: mutate the init it was passed (or
        // produce a fresh object) and return it. Both styles seen in the
        // wild — be robust by returning a merged object.
        const merged: RequestInit & ApplyOpts = {
          ...(init ?? {}),
          ...applyOpts,
        };
        if (applyOpts.headers) {
          merged.headers = applyOpts.headers;
        }
        return merged;
      }),
      getCurrentCluster: vi.fn(() => getCurrentClusterReturn),
    } as unknown as k8s.KubeConfig;
    return kc;
  }

  test("injects kubeconfig auth header into fetch call", async () => {
    const { buildProxyFetch } = await importApiProxy();

    const fetchSpy = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const kc = makeMockKubeConfig({
      headers: { Authorization: "Bearer cluster-token-xyz" },
    });

    const proxyFetch = buildProxyFetch({ kubeConfig: kc });

    await proxyFetch(
      "https://kube.example.com:6443/api/v1/namespaces/n/services/s:80/proxy/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer cluster-token-xyz");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("kubeconfig Authorization wins over caller-supplied Authorization (for MCP server)", async () => {
    // The MCP SDK can pass an `Authorization` header for the upstream MCP
    // server. When tunnelling through the K8s proxy we drop it and use the
    // kubeconfig-derived one — the inner server is reached over cluster-
    // internal trust, NOT via a customer bearer token.
    const { buildProxyFetch } = await importApiProxy();

    const fetchSpy = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const kc = makeMockKubeConfig({
      headers: { Authorization: "Bearer cluster-token-xyz" },
    });

    const proxyFetch = buildProxyFetch({ kubeConfig: kc });

    await proxyFetch(
      "https://kube.example.com:6443/api/v1/namespaces/n/services/s:80/proxy/mcp",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer mcp-server-token-SHOULD-BE-DROPPED",
          "Mcp-Session-Id": "session-1",
          "Content-Type": "application/json",
        },
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    // Cluster auth wins — caller's MCP server token is dropped.
    expect(headers.get("Authorization")).toBe("Bearer cluster-token-xyz");
    // Session id and other passthrough headers are preserved.
    expect(headers.get("Mcp-Session-Id")).toBe("session-1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("forwards undici dispatcher / https agent from applyToFetchOptions", async () => {
    const { buildProxyFetch } = await importApiProxy();

    const fetchSpy = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Use a tagged sentinel so we can identify it in the fetch call.
    const SENTINEL_AGENT = { __id: "sentinel-undici-agent" };

    const kc = makeMockKubeConfig({
      headers: { Authorization: "Bearer t" },
      dispatcher: SENTINEL_AGENT,
    });

    const proxyFetch = buildProxyFetch({ kubeConfig: kc });

    await proxyFetch(
      "https://kube.example.com:6443/api/v1/namespaces/n/services/s:80/proxy/mcp",
      { method: "GET" },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [
      unknown,
      RequestInit & { dispatcher?: unknown; agent?: unknown },
    ];
    // Either dispatcher (undici) or agent (legacy https) MUST be forwarded —
    // failing to do so means TLS / client cert auth from the kubeconfig is
    // never applied and the proxy fetch will 401.
    expect(init.dispatcher ?? init.agent).toBe(SENTINEL_AGENT);
  });

  test("does not buffer response — body remains streamable", async () => {
    // K8s API proxy supports streaming bodies (SSE). The wrapper must not
    // call `.text()` / `.json()` on the response — the caller (MCP SDK)
    // needs the raw streaming body.
    const { buildProxyFetch } = await importApiProxy();

    // Build a streaming response
    const encoder = new TextEncoder();
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (chunks < 3) {
          ctrl.enqueue(encoder.encode(`data: chunk-${chunks}\n\n`));
          chunks += 1;
        } else {
          ctrl.close();
        }
      },
    });

    const streamingResponse = new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const fetchSpy = vi.fn(async () => streamingResponse);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const kc = makeMockKubeConfig({
      headers: { Authorization: "Bearer t" },
    });

    const proxyFetch = buildProxyFetch({ kubeConfig: kc });

    const res = await proxyFetch(
      "https://kube.example.com:6443/api/v1/namespaces/n/services/s:80/proxy/mcp",
      { method: "POST" },
    );

    // The body MUST still be readable by the caller — i.e. not consumed.
    expect(res.bodyUsed).toBe(false);
    expect(res.body).not.toBeNull();
    // Confirm we can still consume it ourselves now.
    const text = await res.text();
    expect(text).toContain("chunk-0");
    expect(text).toContain("chunk-2");
  });
});
