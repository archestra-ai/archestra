import { describe, expect } from "vitest";
import { EnvironmentModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { afterEach, beforeEach, test } from "@/test";
import {
  environmentClusters,
  kubeconfigSecretValue,
} from "./environment-clusters";
import { parseEnvironmentKubeconfig } from "./environment-kubeconfig";

const SERVER = "https://cluster-b.test:6443";

function normalizedKubeconfig(token: string): string {
  return parseEnvironmentKubeconfig(
    [
      "apiVersion: v1",
      "kind: Config",
      "current-context: workloads",
      "clusters:",
      "  - name: workloads",
      "    cluster:",
      `      server: ${SERVER}`,
      "users:",
      "  - name: platform",
      "    user:",
      `      token: ${token}`,
      "contexts:",
      "  - name: workloads",
      "    context:",
      "      cluster: workloads",
      "      user: platform",
      "",
    ].join("\n"),
  ).normalized;
}

async function storeKubeconfig(token: string): Promise<string> {
  const secret = await secretManager().createSecret(
    kubeconfigSecretValue(normalizedKubeconfig(token)),
    `environment-kubeconfig-${token}`,
  );
  return secret.id;
}

/** Replace the environment's credential the way the service does. */
async function rotate(
  environment: {
    id: string;
    organizationId: string;
    kubeconfigSecretId: string | null;
  },
  token: string,
) {
  const replaced = environment.kubeconfigSecretId as string;
  const updated = await EnvironmentModel.update({
    id: environment.id,
    organizationId: environment.organizationId,
    rotatedKubeconfigSecretId: await storeKubeconfig(token),
    replacedKubeconfigSecretId: replaced,
  });
  await secretManager().deleteSecret(replaced);
  if (!updated) throw new Error("rotation changed nothing");
  return updated;
}

const tokenOf = (cluster: { kubeConfig: { getCurrentUser(): unknown } }) =>
  (cluster.kubeConfig.getCurrentUser() as { token?: string } | null)?.token;

describe("environmentClusters", () => {
  beforeEach(() => environmentClusters.stop());
  afterEach(() => environmentClusters.stop());

  test("hands out one client set per environment, bound to its own cluster", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Workloads",
      namespace: "team-a",
      kubeconfig: {
        secretId: await storeKubeconfig("token-1"),
        server: SERVER,
      },
    });

    const cluster = await environmentClusters.forEnvironment(environment);

    expect(cluster.environmentId).toBe(environment.id);
    expect(cluster.kubeConfig.getCurrentCluster()?.server).toBe(SERVER);
    expect(tokenOf(cluster)).toBe("token-1");
    await expect(
      environmentClusters.forEnvironmentId(environment.id),
    ).resolves.toBe(cluster);
  });

  test("a rotated credential reaches clients that were handed out before it", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Workloads",
      namespace: "team-a",
      kubeconfig: {
        secretId: await storeKubeconfig("token-1"),
        server: SERVER,
      },
    });
    const before = await environmentClusters.forEnvironment(environment);

    const rotated = await rotate(environment, "token-2");
    const after = await environmentClusters.forEnvironment(rotated);

    expect(after).toBe(before);
    expect(tokenOf(before)).toBe("token-2");
  });

  test("a caller holding the row from before a rotation still gets the current credential", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const stale = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Workloads",
      namespace: "team-a",
      kubeconfig: {
        secretId: await storeKubeconfig("token-1"),
        server: SERVER,
      },
    });
    // Another replica rotates: this process has loaded nothing yet, and the
    // secret the stale row names no longer exists.
    await rotate(stale, "token-2");

    const cluster = await environmentClusters.forEnvironment(stale);

    expect(tokenOf(cluster)).toBe("token-2");
  });

  test("refuses clients for an environment that is being deleted, except to clean it up", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const environment = await EnvironmentModel.create({
      organizationId: organization.id,
      name: "Workloads",
      namespace: "team-a",
      kubeconfig: {
        secretId: await storeKubeconfig("token-1"),
        server: SERVER,
      },
    });
    await EnvironmentModel.markDeleting({
      id: environment.id,
      organizationId: organization.id,
      blocking: [],
    });

    await expect(
      environmentClusters.forEnvironmentId(environment.id),
    ).rejects.toThrow();
    await expect(
      environmentClusters.beginWrite(environment.id),
    ).rejects.toThrow();
    await expect(
      environmentClusters.forEnvironmentId(environment.id, {
        forCleanup: true,
      }),
    ).resolves.toMatchObject({ environmentId: environment.id });
  });

  test("an id that names no environment never resolves to the platform's cluster", async () => {
    await expect(
      environmentClusters.forEnvironmentId(
        "00000000-0000-4000-8000-00000000dead",
      ),
    ).rejects.toThrow();
  });
});
