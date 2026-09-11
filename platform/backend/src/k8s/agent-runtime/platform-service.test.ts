import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { buildAgentRuntimePlatformEgressPolicy } from "./manifests";
import { resolvePlatformServiceDestination } from "./platform-service";

describe("platform Service egress", () => {
  it("resolves an unqualified Service name in the runtime pod namespace", async () => {
    const readNamespacedService = vi.fn(async () => ({
      spec: { clusterIP: "172.21.40.50" },
    }));
    await resolvePlatformServiceDestination({
      coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
      baseUrl: "http://api:9000",
      platformNamespace: "control-plane",
      runtimeNamespace: "runtime",
    });
    expect(readNamespacedService).toHaveBeenCalledWith({
      name: "api",
      namespace: "runtime",
    });
  });

  it("allows exact Service IPs on the Service port alongside endpoint access", async () => {
    const readNamespacedService = vi.fn(async () => ({
      spec: { clusterIPs: ["172.21.40.50", "fd00:1234::50"] },
    }));
    const platformService = await resolvePlatformServiceDestination({
      coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
      baseUrl: "http://api.platform.svc.cluster.local:8080",
      platformNamespace: "platform",
      runtimeNamespace: "platform",
    });
    expect(readNamespacedService).toHaveBeenCalledWith({
      name: "api",
      namespace: "platform",
    });
    const policy = buildAgentRuntimePlatformEgressPolicy({
      spec: {
        frozenName: "test-run",
        namespace: "runtime",
        taskId: "test-task",
        agentRuntimeId: "test-agent",
        ownerReferences: undefined,
      },
      platformNamespace: "platform",
      platformPodLabels: { app: "api" },
      platformPorts: [9000],
      platformService,
    });
    expect(policy.spec?.egress?.[0]).toMatchObject({
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "platform" },
          },
          podSelector: { matchLabels: { app: "api" } },
        },
      ],
      ports: [{ protocol: "TCP", port: 9000 }],
    });
    expect(policy.spec?.egress?.[1]).toEqual({
      to: [
        { ipBlock: { cidr: "172.21.40.50/32" } },
        { ipBlock: { cidr: "fd00:1234::50/128" } },
      ],
      ports: [{ protocol: "TCP", port: 8080 }],
    });
  });

  it.each([
    "http://api:9000",
    "http://api.platform:9000",
    "http://api.platform.svc:9000",
    "http://api.platform.svc.custom.cluster:9000",
  ])("resolves Service URL %s", async (baseUrl) => {
    const readNamespacedService = vi.fn(async () => ({
      spec: { clusterIP: "172.21.40.50" },
    }));
    expect(
      await resolvePlatformServiceDestination({
        coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
        baseUrl,
        platformNamespace: "platform",
        runtimeNamespace: "platform",
      }),
    ).toEqual({ ips: ["172.21.40.50"], port: 9000 });
    expect(readNamespacedService).toHaveBeenCalledWith({
      name: "api",
      namespace: "platform",
    });
  });

  it.each([
    "",
    "https://api.example.com",
    "https://example.com",
  ])("does not look up external or absent destination %s as a Service", async (baseUrl) => {
    const readNamespacedService = vi.fn();
    expect(
      await resolvePlatformServiceDestination({
        coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
        baseUrl,
        platformNamespace: "platform",
        runtimeNamespace: "platform",
      }),
    ).toBeUndefined();
    expect(readNamespacedService).not.toHaveBeenCalled();
  });

  it.each([
    { baseUrl: "http://172.21.40.50", ips: ["172.21.40.50"], port: 80 },
    { baseUrl: "https://[fd00:1234::50]", ips: ["fd00:1234::50"], port: 443 },
  ])("uses explicit destination $baseUrl without DNS lookup", async ({
    baseUrl,
    ips,
    port,
  }) => {
    const readNamespacedService = vi.fn();
    expect(
      await resolvePlatformServiceDestination({
        coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
        baseUrl,
        platformNamespace: "platform",
        runtimeNamespace: "platform",
      }),
    ).toEqual({ ips, port });
    expect(readNamespacedService).not.toHaveBeenCalled();
  });

  it("does not render a CIDR for a headless Service", async () => {
    const readNamespacedService = vi.fn(async () => ({
      spec: { clusterIP: "None" },
    }));
    expect(
      await resolvePlatformServiceDestination({
        coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
        baseUrl: "https://api.platform.svc",
        platformNamespace: "platform",
        runtimeNamespace: "platform",
      }),
    ).toEqual({ ips: [], port: 443 });
  });

  it("fails a Service lookup error instead of silently installing an incomplete policy", async () => {
    const readNamespacedService = vi.fn(async () => {
      throw new Error("Service lookup unavailable");
    });
    await expect(
      resolvePlatformServiceDestination({
        coreApi: { readNamespacedService } as unknown as k8s.CoreV1Api,
        baseUrl: "http://api.platform.svc:9000",
        platformNamespace: "platform",
        runtimeNamespace: "platform",
      }),
    ).rejects.toThrow("Service lookup unavailable");
  });
});
