import { afterEach, describe, expect, test, vi } from "vitest";
import {
  clearK8sCapabilitiesCache,
  getK8sCapabilitiesFromApi,
} from "./capabilities";

describe("Kubernetes capability inspection", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearK8sCapabilitiesCache();
  });

  test("reports Cilium FQDN support when the CiliumNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "cilium.io" ? [{ name: "ciliumnetworkpolicies" }] : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledWith({
      group: "cilium.io",
      version: "v2",
    });
    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: true,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "cilium",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("falls back to Kubernetes NetworkPolicy when the Cilium CRD is absent", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn().mockRejectedValue({ statusCode: 404 }),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: false,
      provider: "kubernetes",
      supportsFqdn: false,
      supportsHttpMethods: false,
    });
  });

  test("reports GKE FQDN support when the FQDNNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "networking.gke.io"
            ? [{ name: "fqdnnetworkpolicies" }]
            : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: true,
      awsApplicationNetworkPolicy: false,
      provider: "gke-fqdn",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("reports AWS FQDN support when the ApplicationNetworkPolicy CRD exists", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async ({ group }: { group: string }) => ({
        resources:
          group === "networking.k8s.aws"
            ? [{ name: "applicationnetworkpolicies" }]
            : [],
      })),
    };

    const capabilities = await getK8sCapabilitiesFromApi(
      customObjectsApi as never,
    );

    expect(capabilities.networkPolicy).toMatchObject({
      kubernetesNetworkPolicy: true,
      ciliumNetworkPolicy: false,
      gkeFqdnNetworkPolicy: false,
      awsApplicationNetworkPolicy: true,
      provider: "aws-application-network-policy",
      supportsFqdn: true,
      supportsHttpMethods: false,
    });
  });

  test("caches CRD inspection for the same Kubernetes API object", async () => {
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };

    await getK8sCapabilitiesFromApi(customObjectsApi as never);
    await getK8sCapabilitiesFromApi(customObjectsApi as never);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(3);
  });

  test("reprobes after the capability cache TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const customObjectsApi = {
      getAPIResources: vi.fn(async () => ({ resources: [] })),
    };

    await getK8sCapabilitiesFromApi(customObjectsApi as never);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await getK8sCapabilitiesFromApi(customObjectsApi as never);

    expect(customObjectsApi.getAPIResources).toHaveBeenCalledTimes(6);
  });
});
