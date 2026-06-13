import type * as k8s from "@kubernetes/client-node";
import { describe, expect, test, vi } from "@/test";
import { clusterDnsResolver, parseResolvConfNameservers } from "./cluster-dns";

describe("clusterDnsResolver", () => {
  test("resolves the kube-dns service ClusterIPs", async () => {
    const coreApi = {
      readNamespacedService: vi.fn(async () => ({
        spec: { clusterIP: "172.20.0.10", clusterIPs: ["172.20.0.10"] },
      })),
    } as unknown as k8s.CoreV1Api;

    await expect(clusterDnsResolver.getClusterDnsIps(coreApi)).resolves.toEqual(
      ["172.20.0.10"],
    );
    expect(coreApi.readNamespacedService).toHaveBeenCalledWith({
      name: "kube-dns",
      namespace: "kube-system",
    });
  });

  test("falls back to listing kube-system services by the kube-dns label", async () => {
    const coreApi = {
      readNamespacedService: vi.fn(async () => {
        throw { statusCode: 404 };
      }),
      listNamespacedService: vi.fn(async () => ({
        items: [{ spec: { clusterIP: "10.100.0.10" } }],
      })),
    } as unknown as k8s.CoreV1Api;

    await expect(clusterDnsResolver.getClusterDnsIps(coreApi)).resolves.toEqual(
      ["10.100.0.10"],
    );
    expect(coreApi.listNamespacedService).toHaveBeenCalledWith({
      namespace: "kube-system",
      labelSelector: "k8s-app=kube-dns",
    });
  });

  test("returns an empty array when nothing can be resolved", async () => {
    const coreApi = {} as k8s.CoreV1Api;

    await expect(clusterDnsResolver.getClusterDnsIps(coreApi)).resolves.toEqual(
      [],
    );
  });

  test("ignores headless services and invalid IPs", async () => {
    const coreApi = {
      readNamespacedService: vi.fn(async () => ({
        spec: { clusterIP: "None" },
      })),
      listNamespacedService: vi.fn(async () => ({
        items: [{ spec: { clusterIP: "not-an-ip" } }],
      })),
    } as unknown as k8s.CoreV1Api;

    await expect(clusterDnsResolver.getClusterDnsIps(coreApi)).resolves.toEqual(
      [],
    );
  });

  test("caches the result per API client", async () => {
    const readNamespacedService = vi.fn(async () => ({
      spec: { clusterIPs: ["172.20.0.10"] },
    }));
    const coreApi = { readNamespacedService } as unknown as k8s.CoreV1Api;

    await clusterDnsResolver.getClusterDnsIps(coreApi);
    await clusterDnsResolver.getClusterDnsIps(coreApi);

    expect(readNamespacedService).toHaveBeenCalledTimes(1);
  });
});

describe("parseResolvConfNameservers", () => {
  test("extracts valid nameserver IPs", () => {
    expect(
      parseResolvConfNameservers(
        [
          "search default.svc.cluster.local svc.cluster.local",
          "nameserver 172.20.0.10",
          "nameserver fd00::10",
          "nameserver bogus",
          "options ndots:5",
        ].join("\n"),
      ),
    ).toEqual(["172.20.0.10", "fd00::10"]);
  });
});
