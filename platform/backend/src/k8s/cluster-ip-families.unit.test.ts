import { randomUUID } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
import { describe, expect, test, vi } from "vitest";
import { clusterIpFamilyResolver } from "./cluster-ip-families";

describe("clusterIpFamilyResolver", () => {
  test("IPv4-only cluster: pods carry only IPv4 addresses", async () => {
    const coreApi = podsApi([pod({ podIPs: ["10.0.1.5"] })]);

    await expect(resolve(coreApi)).resolves.toEqual(["IPv4"]);
  });

  test("IPv6-only cluster: pods carry only IPv6 addresses", async () => {
    const coreApi = podsApi([pod({ podIPs: ["2600:1f14::5"] })]);

    await expect(resolve(coreApi)).resolves.toEqual(["IPv6"]);
  });

  test("dual-stack cluster: pods carry both families, even though the DNS Service is single-stack", async () => {
    const coreApi = podsApi([pod({ podIPs: ["10.0.1.5", "fd00:10::5"] })]);

    await expect(resolve(coreApi, ["10.96.0.10"])).resolves.toEqual([
      "IPv4",
      "IPv6",
    ]);
  });

  test("reads the legacy single podIP and lists only running pods", async () => {
    const coreApi = podsApi([pod({ podIP: "10.0.1.5" })]);

    await expect(resolve(coreApi)).resolves.toEqual(["IPv4"]);
    expect(coreApi.listNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ fieldSelector: "status.phase=Running" }),
    );
  });

  test("ignores host-network pods, whose addresses are the node's", async () => {
    const coreApi = podsApi([
      pod({ podIPs: ["fd00:10::5"], hostNetwork: true }),
      pod({ podIPs: ["10.0.1.5"] }),
    ]);

    await expect(resolve(coreApi)).resolves.toEqual(["IPv4"]);
  });

  test("falls back to the cluster DNS IP families when no pod has an address", async () => {
    await expect(resolve(podsApi([]), ["fd00:ec2::10"])).resolves.toEqual([
      "IPv6",
    ]);
    await expect(resolve(failingPodsApi(), ["172.20.0.10"])).resolves.toEqual([
      "IPv4",
    ]);
  });

  test("returns an empty array when nothing can be determined", async () => {
    await expect(resolve(failingPodsApi(), [])).resolves.toEqual([]);
  });

  test("caches a determined result per namespace", async () => {
    const coreApi = podsApi([pod({ podIPs: ["10.0.1.5"] })]);
    const namespace = `ns-${randomUUID()}`;
    const params = { coreApi, namespace, clusterDnsIps: [] };

    await clusterIpFamilyResolver.getIpFamilies(params);
    await clusterIpFamilyResolver.getIpFamilies(params);

    expect(coreApi.listNamespacedPod).toHaveBeenCalledTimes(1);
  });
});

// === Helpers ===

// A fresh namespace per call keeps the per-namespace cache from leaking
// between tests.
function resolve(coreApi: k8s.CoreV1Api, clusterDnsIps: string[] = []) {
  return clusterIpFamilyResolver.getIpFamilies({
    coreApi,
    namespace: `ns-${randomUUID()}`,
    clusterDnsIps,
  });
}

function podsApi(items: k8s.V1Pod[]) {
  return {
    listNamespacedPod: vi.fn(async () => ({ items })),
  } as unknown as k8s.CoreV1Api & {
    listNamespacedPod: ReturnType<typeof vi.fn>;
  };
}

function failingPodsApi() {
  return {
    listNamespacedPod: vi.fn(async () => {
      throw { statusCode: 403 };
    }),
  } as unknown as k8s.CoreV1Api;
}

function pod(params: {
  podIPs?: string[];
  podIP?: string;
  hostNetwork?: boolean;
}): k8s.V1Pod {
  return {
    spec: { containers: [], hostNetwork: params.hostNetwork },
    status: {
      podIP: params.podIP ?? params.podIPs?.[0],
      podIPs: params.podIPs?.map((ip) => ({ ip })),
    },
  };
}
