// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { testMcpServerCommand } from "@archestra/shared/test-mcp-server";
import * as k8s from "@kubernetes/client-node";
import type { APIRequestContext } from "@playwright/test";
import {
  DEFAULT_TEAM_NAME,
  ENGINEERING_TEAM_NAME,
  MCP_SERVER_NAMESPACE,
} from "../consts";
// `apiRequest` is the plain helper, not the same-named test fixture: the
// describe-scoped readers below cannot take fixtures.
import {
  makeApiRequest as apiRequest,
  callMcpTool,
  getTeamTokenForProfile,
  waitForServerInstallation,
} from "../utils";
import { expect, test } from "./api-fixtures";
import {
  assertHibernationTimingProfile,
  hibernationTiming,
} from "./hibernation-timing";

/**
 * Deployment annotations written by `K8sDeployment.hibernate()` and removed by
 * `completeWake()` (constants live in backend/src/k8s/shared.ts). Repeated as
 * literals here because e2e-tests does not depend on the backend workspace —
 * and because they are a Kubernetes API contract: what the cluster object
 * actually carries is exactly what this spec must assert on.
 */
const MCP_HIBERNATED_ANNOTATION = "archestra.io/hibernated";
const MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION =
  "archestra.io/pre-hibernation-replicas";

/** The fixture server's only tool; the prefix embeds the generated catalog name. */
const TEST_TOOL_SUFFIX = "print_archestra_test";

const MULTITENANT_ENV_VALUE = "hibernation-topology-multitenant";
const CUSTOM_YAML_ENV_VALUE = "hibernation-topology-custom-yaml";

/**
 * The multitenant catalog's execution config, shared by the create call and by
 * the config edit at the end of the spec — that edit must differ from this in
 * exactly one dimension (a newly prompted variable), so it has to be built
 * from the same object rather than retyped.
 */
const MULTITENANT_LOCAL_CONFIG = {
  command: "sh",
  arguments: ["-c", testMcpServerCommand.replace(/\n/g, " ")],
  transportType: "stdio",
  environment: [
    {
      key: "ARCHESTRA_TEST",
      type: "plain_text",
      value: MULTITENANT_ENV_VALUE,
      promptOnInstallation: false,
    },
  ],
};

/**
 * Replica count the custom-YAML fixture pins. Must be > 1: the whole point is
 * that a wake restores the deployment's OWN count rather than the platform
 * default of 1 (MCP_ORCHESTRATOR_DEFAULTS.replicas).
 */
const CUSTOM_YAML_REPLICAS = 2;

/**
 * Attempt budget for `waitForServerInstallation` (one attempt ≈ 2 s). Its
 * default of 60 is a hard 120 s ceiling that `test.setTimeout` cannot raise,
 * and the install route only reports success after its own readiness wait plus
 * tool discovery — a cold node (image pull, then `npm install` of the MCP SDK
 * inside the pod) routinely needs more than that.
 */
const INSTALL_WAIT_ATTEMPTS = 120;

const HIBERNATION_DEADLINE_MS = hibernationTiming.hibernationDeadlineMs;
const HIBERNATION_POLL_INTERVALS = hibernationTiming.clusterPollIntervals;

interface InstallFixture {
  id: string;
  /**
   * Row name, which is also this install's metric `server_name`. The install
   * route resets the name to the catalog item's, and the row is then suffixed
   * with the scope it was created for (`<catalog>-<teamId>` for a team
   * install) — so two installs of one catalog are distinguishable in the
   * metric ONLY because they were installed for different teams.
   */
  name: string;
  gatewayId: string;
  token: string;
  toolName: string;
}

/**
 * MCP idle hibernation — deployment TOPOLOGIES and the per-install override.
 *
 * The happy path (one install, one deployment) is covered by
 * mcp-hibernation.spec.ts. What is pinned here is everything that stops being
 * obvious once a deployment is not one-to-one with an install:
 *
 *   - a multitenant catalog's installs share ONE physical Deployment, so
 *     sleeping it must show up on every install and waking it for one must
 *     serve all of them;
 *   - `hibernationMode` is per-install but resolves per GROUP, and its write
 *     paths differ (the catalog PUT cascades onto every install, the reinstall
 *     body pins a single one);
 *   - a deployment built from advanced YAML is an ordinary hibernation
 *     citizen, including one that runs more than a single replica.
 *
 * Two kinds of sleep appear below, and the difference is deliberate. Where the
 * test only needs a deployment that is ALREADY asleep, the hibernated shape is
 * injected directly — spec.replicas 0 plus both annotations in one merge
 * patch, exactly what `hibernate()` writes — because the platform's decision is
 * not what is being measured and a real idle window costs minutes. Where the
 * platform's DECISION is the claim (the per-install veto, and the replica count
 * it records for a multi-replica deployment), the organization-wide toggle is
 * turned on and a real sweep does the work; those tests turn it straight back
 * off, and the afterAll restores it on the failure path too.
 *
 * That toggle is organization-wide, so while it is on every idle deployment in
 * the cluster is a candidate — including this spec's other fixture. Whichever
 * deployment is not the subject of a given test is therefore pinned
 * `hibernationMode: "disabled"` for the duration, which is the platform's own
 * mechanism for holding a deployment out of a sweep.
 *
 * Every fixture here is spec-owned (its own catalogs, installs and gateways),
 * so nothing it sleeps or breaks can reach a sibling spec's deployment.
 *
 * Only the veto test is `@slow-window`: it is the one that has to sit through
 * idle windows in wall-clock time, twice, because "the platform declined to
 * sleep this" is a claim about the whole window. The custom-YAML test also
 * waits for a real sweep, but its deployment has been idle since it was
 * installed, so it waits out a sweep tick rather than a window — which is what
 * keeps a genuine platform-decided hibernation in the pre-merge run.
 */
test.describe("MCP idle hibernation - deployment topologies", () => {
  // Installing MCP servers (each pod npm-installs the MCP SDK before it can
  // answer), sleeping a deployment and waking it again — the wake's readiness
  // wait alone budgets ~44 s — is well past the default 60 s.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let appsApi: k8s.AppsV1Api;
  let coreApi: k8s.CoreV1Api;

  /**
   * Everything this spec creates in the cluster or the database, published the
   * moment it exists rather than when the step that creates it returns. A
   * fixture build that throws half-way still leaves the afterAll able to
   * remove what it got as far as.
   */
  const createdCatalogIds: string[] = [];
  const createdInstallIds: string[] = [];
  const createdGatewayIds: string[] = [];
  const createdDeploymentNames: string[] = [];

  /** The organization's hibernation toggle as this spec found it. */
  let organizationHibernationBefore = false;

  // ── Multitenant fixture: two installs, one physical Deployment ──────────
  let multitenantCatalogId: string;
  /** Frozen on the CATALOG row — the shared deployment's real identity. */
  let sharedDeploymentName: string;
  let installA: InstallFixture;
  let installB: InstallFixture;
  /** Shape of the shared Deployment before this spec slept it. */
  let sharedReplicas: number;
  let sharedDeploymentUid: string | undefined;
  let sharedPodNames: string[] = [];
  /** Tool output the shared pod produced while awake; the wake must repeat it. */
  let multitenantToolText: string;

  // ── Custom-YAML fixture: one install, deployment pinned to 2 replicas ───
  let customYamlCatalogId: string;
  let customYamlInstall: InstallFixture;
  let customYamlDeploymentName: string;

  const readDeployment = (name: string) =>
    appsApi.readNamespacedDeployment({
      name,
      namespace: MCP_SERVER_NAMESPACE,
    });

  const deploymentExists = async (name: string): Promise<boolean> => {
    try {
      await readDeployment(name);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Deployments carrying an `mcp-server-id` label. The platform stamps the
   * CATALOG id there for a multitenant catalog and the INSTALL id otherwise
   * (K8sDeployment.getPodSelectorServerId), so this answers "how many physical
   * deployments does this identity own" for either topology.
   */
  const listDeploymentNamesForServerId = async (
    serverId: string,
  ): Promise<string[]> => {
    const deployments = await appsApi.listNamespacedDeployment({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: `mcp-server-id=${serverId}`,
    });
    return deployments.items
      .map((item) => item.metadata?.name ?? "")
      .filter(Boolean)
      .sort();
  };

  const listRunningPodNames = async (serverId: string): Promise<string[]> => {
    const pods = await coreApi.listNamespacedPod({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: `mcp-server-id=${serverId}`,
    });
    return pods.items
      .filter((pod) => pod.status?.phase === "Running")
      .map((pod) => pod.metadata?.name ?? "")
      .filter(Boolean)
      .sort();
  };

  const countPods = async (serverId: string): Promise<number> => {
    const pods = await coreApi.listNamespacedPod({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: `mcp-server-id=${serverId}`,
    });
    return pods.items.length;
  };

  /**
   * Put a Deployment into exactly the shape `K8sDeployment.hibernate()` leaves
   * behind: replicas 0 and both annotations in ONE merge patch, so they can
   * never be observed out of sync. `replicas` is the count observed live, i.e.
   * what the platform itself would have recorded.
   */
  const hibernateOutOfBand = async (params: {
    deploymentName: string;
    replicas: number;
  }): Promise<void> => {
    await appsApi.patchNamespacedDeployment(
      {
        name: params.deploymentName,
        namespace: MCP_SERVER_NAMESPACE,
        body: {
          metadata: {
            annotations: {
              [MCP_HIBERNATED_ANNOTATION]: "true",
              [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: String(
                params.replicas,
              ),
            },
          },
          spec: { replicas: 0 },
        },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );
  };

  const readHibernationShape = async (deploymentName: string) => {
    const deployment = await readDeployment(deploymentName);
    return {
      replicas: deployment.spec?.replicas,
      hibernated: deployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
      preHibernationReplicas:
        deployment.metadata?.annotations?.[
          MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION
        ],
    };
  };

  /**
   * The organization-wide master switch. With it off nothing hibernates
   * whatever the per-install modes say, so every cluster-side claim about the
   * platform's own sweep has to turn it on first.
   */
  const setOrganizationHibernation = async (
    request: APIRequestContext,
    enabled: boolean,
  ): Promise<void> => {
    await apiRequest({
      request,
      method: "patch",
      urlSuffix: "/api/organization/mcp-settings",
      data: { mcpIdleHibernationEnabled: enabled },
    });
  };

  /**
   * The group write path for `hibernationMode`: catalog-scoped, cascading onto
   * every install of the catalog without reinstalling anything.
   */
  const setCatalogHibernationMode = async (
    request: APIRequestContext,
    catalogId: string,
    mode: "inherit" | "disabled",
  ): Promise<void> => {
    await apiRequest({
      request,
      method: "put",
      urlSuffix: `/api/internal_mcp_catalog/${catalogId}`,
      data: { hibernationMode: mode },
    });
  };

  /**
   * Sleep until a full idle window has certainly elapsed since `since`. Only
   * a wait this long makes "the platform did NOT sleep it" a claim that could
   * have failed.
   */
  const waitOutIdleWindow = async (since: number): Promise<void> => {
    const remainingMs = since + HIBERNATION_DEADLINE_MS - Date.now();
    if (remainingMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  };

  const callTool = async (
    request: APIRequestContext,
    install: InstallFixture,
  ): Promise<string> => {
    const result = await callMcpTool(request, {
      profileId: install.gatewayId,
      token: install.token,
      toolName: install.toolName,
      timeoutMs: 120_000,
    });
    return result.content.find((part) => part.type === "text")?.text ?? "";
  };

  /** The install row as the API serves it, including its hibernation fields. */
  const readInstall = async (
    request: APIRequestContext,
    installId: string,
  ): Promise<{
    hibernationMode: string;
    reinstallRequired: boolean;
    reinstallReason: string | null;
  }> => {
    const response = await apiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${installId}`,
    });
    return response.json();
  };

  /**
   * Refuse to make a per-install claim the observable cannot carry. Both
   * "visible on every install" assertions below read one metric series per
   * install, keyed by the install's row name, and collect them into an object
   * literal keyed by the same two names. Were those names ever equal — the
   * install route does force the row name to the catalog item's, and only the
   * scope suffix keeps these two apart — the literal would collapse to a
   * single property and the assertion would be one observation written twice,
   * unable to fail for anything specific to the second install. The install
   * ids are distinct by construction; the NAMES are what the metric is keyed
   * on, so they are what has to be checked.
   */
  const requireDistinctInstallIdentities = (): void => {
    expect(installA.name).toBeTruthy();
    expect(
      installB.name,
      "the two installs must report under different identifiers, or no metric assertion below can tell them apart",
    ).not.toBe(installA.name);
  };

  test.beforeAll(
    async ({
      request,
      makeApiRequest,
      createMcpCatalogItem,
      installMcpServer,
      getTeamByName,
      waitForAgentTool,
    }) => {
      // Three MCP pods have to reach Ready here (one shared, two replicas of
      // the custom-YAML deployment) and each runs `npm install` for the MCP
      // SDK before it answers anything. Large enough to cover all three
      // installs spending their full INSTALL_WAIT_ATTEMPTS budget plus the
      // tool-discovery polls, since the fixtures are built one after another.
      test.setTimeout(1_200_000);
      await assertHibernationTimingProfile({ request, makeApiRequest });

      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      appsApi = kc.makeApiClient(k8s.AppsV1Api);
      coreApi = kc.makeApiClient(k8s.CoreV1Api);

      // Start from the platform default rather than from whatever the previous
      // spec left behind: the first three tests below assert on a cluster in
      // which nothing hibernates unless this spec asks for it.
      const organizationResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/organization",
      });
      organizationHibernationBefore =
        (await organizationResponse.json()).mcpIdleHibernationEnabled === true;
      await setOrganizationHibernation(request, false);

      const [defaultTeam, engineeringTeam] = await Promise.all([
        getTeamByName(request, DEFAULT_TEAM_NAME),
        getTeamByName(request, ENGINEERING_TEAM_NAME),
      ]);

      /** Resolve the catalog's tool, pin it to ONE install, and hand back a callable fixture. */
      const provisionGateway = async (params: {
        installId: string;
        installName: string;
        teamId: string;
        teamName: string;
        gatewayName: string;
      }): Promise<InstallFixture> => {
        const gatewayResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/agents",
          data: {
            name: params.gatewayName,
            agentType: "mcp_gateway",
            scope: "team",
            teams: [params.teamId],
          },
        });
        const gatewayId = (await gatewayResponse.json()).id;
        createdGatewayIds.push(gatewayId);

        // Tool names embed the catalog name, which is generated below —
        // resolve the real one instead of reconstructing the slug.
        let testTool: { id: string; name: string } | undefined;
        await expect
          .poll(
            async () => {
              const toolsResponse = await makeApiRequest({
                request,
                method: "get",
                urlSuffix: `/api/mcp_server/${params.installId}/tools`,
              });
              const tools: Array<{ id: string; name: string }> =
                await toolsResponse.json();
              testTool = tools.find((tool) =>
                tool.name.endsWith(TEST_TOOL_SUFFIX),
              );
              return testTool?.name;
            },
            { timeout: 120_000, intervals: [1_000, 2_000, 5_000] },
          )
          .toBeTruthy();
        if (!testTool) {
          throw new Error(
            "Fixture server exposed no print_archestra_test tool",
          );
        }

        // Pin the assignment to this installation: a multitenant catalog's
        // tool is one row shared by every install, so an unpinned assignment
        // would not say WHICH install's demand a call represents.
        await makeApiRequest({
          request,
          method: "post",
          urlSuffix: `/api/agents/${gatewayId}/tools/${testTool.id}`,
          data: { mcpServerId: params.installId },
        });
        await waitForAgentTool(request, gatewayId, testTool.name);

        return {
          id: params.installId,
          name: params.installName,
          gatewayId,
          token: await getTeamTokenForProfile(request, params.teamName),
          toolName: testTool.name,
        };
      };

      const setUpMultitenantFixture = async (): Promise<void> => {
        // `multitenant: true` is create-only (tenancy is locked afterwards),
        // and the env var is static rather than prompted: one shared pod
        // means one env, so a per-install value would be a fiction.
        //
        // The name stays short because a multitenant catalog's deployment name
        // embeds it unabridged (`mcp-mt-<catalogId8>-<name>`), and Kubernetes
        // rejects names past 63 characters.
        const catalogResponse = await makeApiRequest({
          request,
          method: "post",
          urlSuffix: "/api/internal_mcp_catalog",
          data: {
            name: `e2e-hib-mt-${Date.now()}`,
            description:
              "Dedicated fixture for the MCP hibernation topology e2e spec (shared deployment).",
            serverType: "local",
            multitenant: true,
            localConfig: MULTITENANT_LOCAL_CONFIG,
          },
        });
        const catalogItem = await catalogResponse.json();
        multitenantCatalogId = catalogItem.id;
        createdCatalogIds.push(catalogItem.id);
        sharedDeploymentName = catalogItem.deploymentName;
        expect(
          sharedDeploymentName,
          "a multitenant catalog must freeze its shared deployment name at creation",
        ).toBeTruthy();
        createdDeploymentNames.push(sharedDeploymentName);

        // Two installs of one catalog: an install is unique per (catalog,
        // team), so they differ by team — which is also what gives each one
        // its own team token and gateway below.
        const installResponseA = await installMcpServer(request, {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          scope: "team",
          teamId: defaultTeam.id,
        });
        const installRowA = await installResponseA.json();
        createdInstallIds.push(installRowA.id);
        await waitForServerInstallation(
          request,
          installRowA.id,
          INSTALL_WAIT_ATTEMPTS,
        );

        const installResponseB = await installMcpServer(request, {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          scope: "team",
          teamId: engineeringTeam.id,
        });
        const installRowB = await installResponseB.json();
        createdInstallIds.push(installRowB.id);
        await waitForServerInstallation(
          request,
          installRowB.id,
          INSTALL_WAIT_ATTEMPTS,
        );

        installA = await provisionGateway({
          installId: installRowA.id,
          installName: installRowA.name,
          teamId: defaultTeam.id,
          teamName: DEFAULT_TEAM_NAME,
          gatewayName: `MCP Hibernation Topology Gateway A ${Date.now()}`,
        });
        installB = await provisionGateway({
          installId: installRowB.id,
          installName: installRowB.name,
          teamId: engineeringTeam.id,
          teamName: ENGINEERING_TEAM_NAME,
          gatewayName: `MCP Hibernation Topology Gateway B ${Date.now()}`,
        });
      };

      const setUpCustomYamlFixture = async (): Promise<void> => {
        const catalogResponse = await createMcpCatalogItem(request, {
          name: `e2e-hibernation-custom-yaml-${Date.now()}`,
          description:
            "Dedicated fixture for the MCP hibernation topology e2e spec (advanced YAML).",
          serverType: "local",
          localConfig: {
            command: "sh",
            arguments: ["-c", testMcpServerCommand.replace(/\n/g, " ")],
            transportType: "stdio",
            environment: [
              {
                key: "ARCHESTRA_TEST",
                type: "plain_text",
                value: CUSTOM_YAML_ENV_VALUE,
                promptOnInstallation: false,
              },
            ],
          },
        });
        const catalogItem = await catalogResponse.json();
        customYamlCatalogId = catalogItem.id;
        createdCatalogIds.push(catalogItem.id);

        // The preview is the generated manifest the platform would deploy;
        // editing it turns the catalog into an advanced-YAML one. Done BEFORE
        // the install exists, so the edit cascades to nothing and the very
        // first deployment already runs the pinned replica count.
        const previewResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: `/api/internal_mcp_catalog/${customYamlCatalogId}/deployment-yaml-preview`,
        });
        const generatedYaml: string = (await previewResponse.json()).yaml;
        const pinnedYaml = generatedYaml.replace(
          /^(\s*)replicas: \d+$/m,
          `$1replicas: ${CUSTOM_YAML_REPLICAS}`,
        );
        if (pinnedYaml === generatedYaml) {
          throw new Error(
            "Generated deployment YAML carried no replicas field to pin",
          );
        }

        await makeApiRequest({
          request,
          method: "put",
          urlSuffix: `/api/internal_mcp_catalog/${customYamlCatalogId}`,
          data: { deploymentSpecYaml: pinnedYaml },
        });

        const installResponse = await installMcpServer(request, {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          scope: "team",
          teamId: defaultTeam.id,
        });
        const installRow = await installResponse.json();
        createdInstallIds.push(installRow.id);
        customYamlDeploymentName = installRow.deploymentName;
        expect(
          customYamlDeploymentName,
          "MCP server row must carry its frozen K8s deployment name",
        ).toBeTruthy();
        createdDeploymentNames.push(customYamlDeploymentName);
        await waitForServerInstallation(
          request,
          installRow.id,
          INSTALL_WAIT_ATTEMPTS,
        );

        // Hold this deployment out of every sweep the multitenant tests turn
        // on. The cascade only reaches installs that already exist, so it has
        // to run after the install, not on the catalog beforehand.
        await setCatalogHibernationMode(
          request,
          customYamlCatalogId,
          "disabled",
        );

        customYamlInstall = await provisionGateway({
          installId: installRow.id,
          installName: installRow.name,
          teamId: defaultTeam.id,
          teamName: DEFAULT_TEAM_NAME,
          gatewayName: `MCP Hibernation Topology Gateway YAML ${Date.now()}`,
        });
      };

      // Serial, not concurrent: a builder that throws leaves the other one
      // running against a cluster the afterAll has already started cleaning
      // up, and only the first rejection would ever be reported.
      await setUpMultitenantFixture();
      await setUpCustomYamlFixture();
    },
  );

  test.afterAll(
    async ({
      request,
      deleteAgent,
      uninstallMcpServer,
      deleteMcpCatalogItem,
    }) => {
      test.setTimeout(300_000);

      // First, so a sweep can never fire against a deployment being torn down
      // — and so a test that failed mid-way cannot leave the organization-wide
      // switch flipped for whatever runs next.
      await setOrganizationHibernation(
        request,
        organizationHibernationBefore,
      ).catch(() => {});

      for (const gatewayId of createdGatewayIds) {
        await deleteAgent(request, gatewayId).catch(() => {});
      }
      // Uninstall every install before deleting its catalog: the installs own
      // the Deployment (a multitenant one only goes away with its LAST
      // install), and a catalog delete alone would leave it running.
      for (const installId of createdInstallIds) {
        await uninstallMcpServer(request, installId).catch(() => {});
      }
      for (const catalogId of createdCatalogIds) {
        await deleteMcpCatalogItem(request, catalogId).catch(() => {});
      }

      // Uninstall is the normal path and takes the Deployment with it. If it
      // did not (an early failure, or a spec that stopped between the sleep
      // and the wake), delete it directly: leaving a zero-replica workload
      // behind would keep a hibernated deployment in every later spec's view
      // of the cluster.
      for (const deploymentName of createdDeploymentNames) {
        const gone = await expect
          .poll(async () => !(await deploymentExists(deploymentName)), {
            timeout: 60_000,
            intervals: [2_000, 5_000],
          })
          .toBe(true)
          .then(() => true)
          .catch(() => false);
        if (!gone) {
          await appsApi
            .deleteNamespacedDeployment({
              name: deploymentName,
              namespace: MCP_SERVER_NAMESPACE,
            })
            .catch(() => {});
        }
      }
    },
  );

  test("two installs of a multitenant catalog share one Deployment, and sleeping stops their shared pod", async ({
    request,
  }) => {
    // Two cold tool calls, a scale-to-zero the kubelet has to act on, and the
    // runtime's own watch-driven state refresh — each polled generously
    // because none of them has a synchronous signal.
    test.setTimeout(360_000);
    requireDistinctInstallIdentities();

    // One physical Deployment for both installs. The per-install rows still
    // carry their own frozen names (the column is written for every local
    // install) — what proves the sharing is that nothing in the cluster is
    // keyed on them.
    expect(await listDeploymentNamesForServerId(multitenantCatalogId)).toEqual([
      sharedDeploymentName,
    ]);
    for (const install of [installA, installB]) {
      expect(
        await listDeploymentNamesForServerId(install.id),
        `install ${install.name} must not own a Deployment of its own`,
      ).toEqual([]);
    }

    // Both installs are served, and by the same pod: identical output from
    // two independently-pinned gateways.
    multitenantToolText = await callTool(request, installA);
    expect(multitenantToolText).toContain(
      `ARCHESTRA_TEST = ${MULTITENANT_ENV_VALUE}`,
    );
    expect(await callTool(request, installB)).toBe(multitenantToolText);

    const deployment = await readDeployment(sharedDeploymentName);
    sharedReplicas = deployment.spec?.replicas ?? 1;
    sharedDeploymentUid = deployment.metadata?.uid;
    expect(sharedReplicas).toBeGreaterThan(0);
    expect(
      deployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();
    sharedPodNames = await listRunningPodNames(multitenantCatalogId);
    expect(sharedPodNames.length).toBeGreaterThan(0);

    // Injected rather than swept: what is under test here is that one sleep is
    // visible on both installs, not who decided to sleep it.
    await hibernateOutOfBand({
      deploymentName: sharedDeploymentName,
      replicas: sharedReplicas,
    });

    // The kubelet must actually tear the pod down — otherwise the next test
    // would "wake" a server that never stopped serving.
    await expect
      .poll(async () => countPods(multitenantCatalogId), {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBe(0);

    // Assert cluster truth directly. The metrics NodePort is load-balanced
    // across two web replicas in CI, while each replica reports only the
    // runtime objects it has loaded; a single scrape is therefore not a
    // cluster-wide per-install observable. The independent gateway calls in
    // this and the next test pin the user-visible behavior for both installs.
    expect(await readHibernationShape(sharedDeploymentName)).toEqual({
      replicas: 0,
      hibernated: "true",
      preHibernationReplicas: String(sharedReplicas),
    });
  });

  test("demand on one install wakes the shared pod for every install on it", async ({
    request,
  }) => {
    // A wake schedules a fresh pod that npm-installs the MCP SDK before it can
    // answer, on top of the wake's own ~44s readiness budget.
    test.setTimeout(480_000);
    requireDistinctInstallIdentities();

    // Install B has its own gateway and its own team token, and has made no
    // call since the deployment went to sleep. Its demand alone must run the
    // full wake — nothing else scales this deployment back up: the organization
    // toggle is off, so no sweep is running, and no restart is issued.
    // Retried only to absorb the seconds the runtime's deployment watch needs
    // to notice the out-of-band scale-down: until it does, the cached state
    // still reads "running" and the demand path takes its documented fast
    // path. A broken wake chain fails every attempt.
    await expect(async () => {
      expect(await callTool(request, installB)).toBe(multitenantToolText);
    }).toPass({ timeout: 150_000, intervals: [2_000, 5_000, 10_000] });

    await expect
      .poll(() => readHibernationShape(sharedDeploymentName), {
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toEqual({
        replicas: sharedReplicas,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });

    // A genuinely new pod serves the group, and the wake did not fork a
    // second Deployment for the install that drove it.
    const wokenPodNames = await listRunningPodNames(multitenantCatalogId);
    expect(wokenPodNames.length).toBeGreaterThan(0);
    for (const podName of wokenPodNames) {
      expect(sharedPodNames).not.toContain(podName);
    }
    expect(await listDeploymentNamesForServerId(multitenantCatalogId)).toEqual([
      sharedDeploymentName,
    ]);
    expect(await listDeploymentNamesForServerId(installA.id)).toEqual([]);

    // Install A never asked for anything: one tenant's demand is what brought
    // its pod back, and it is serving on it. A's gateway, token and tool
    // assignment are all pinned to A's install id, so being answered here is
    // A's own observation and not a second reading of B's.
    expect(await callTool(request, installA)).toBe(multitenantToolText);
  });

  /**
   * `@slow-window` marks a test whose runtime is dominated by sitting out real
   * idle windows rather than by anything it asserts — this one sits out two.
   * Nothing selects on it inside this file: the tag exists for the suite
   * runner, which excludes these on the pre-merge run
   * (`--grep-invert=@slow-window`) and includes them on the scheduled full
   * run. So it may leave nothing behind that a later test needs. It does not:
   * it hands the shared deployment back awake, on the same object, with every
   * install on `inherit` and the organization toggle off — which is also the
   * state the two tests after it find if this one never ran at all.
   */
  test("one install pinned `disabled` keeps the whole shared pod awake, and lifting the pin lets the platform sleep it @slow-window", async ({
    request,
    makeApiRequest,
  }) => {
    // Two real idle windows back to back: one the platform must decline to act
    // on, one it must act on — plus the reinstall write, and the wake that
    // hands the following tests a running pod again.
    test.setTimeout(900_000);

    const before = await readDeployment(sharedDeploymentName);
    const replicasBefore = before.spec?.replicas ?? 0;
    expect(replicasBefore).toBeGreaterThan(0);
    const podsBefore = await listRunningPodNames(multitenantCatalogId);
    expect(podsBefore.length).toBeGreaterThan(0);

    // From here the platform is genuinely hibernating idle deployments, which
    // is the only condition under which "it stayed awake" can fail.
    await setOrganizationHibernation(request, true);

    // The per-install write path. It is enterprise-gated at the route (this
    // e2e organization is under the small-team threshold, so the licence is
    // active) and the reinstall it performs is bookkeeping only on a
    // multitenant catalog — the shared pod belongs to the group, not to A.
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server/${installA.id}/reinstall`,
      data: { hibernationMode: "disabled" },
    });
    await waitForServerInstallation(
      request,
      installA.id,
      INSTALL_WAIT_ATTEMPTS,
    );
    // The idle clock can only start here: a reinstall resyncs the install's
    // tools against the live pod, and that call counts as demand on the shared
    // deployment exactly like any other.
    const vetoWindowStart = Date.now();

    const [pinnedA, untouchedB] = await Promise.all([
      readInstall(request, installA.id),
      readInstall(request, installB.id),
    ]);
    expect(pinnedA.hibernationMode).toBe("disabled");
    // The group now holds a veto, but the veto is A's: pinning one install
    // must not rewrite what its siblings asked for. What makes it protect the
    // whole shared pod is the group resolution, not a rewrite of B's row.
    expect(untouchedB.hibernationMode).toBe("inherit");
    // An operational setting, not a config change: A is not left flagged as
    // owing a reinstall.
    expect(pinnedA.reinstallRequired).toBe(false);
    expect(pinnedA.reinstallReason).toBeNull();

    // Nothing about the running deployment moved: same object (uid), same
    // replicas, same pod, and emphatically not asleep.
    const afterPin = await readDeployment(sharedDeploymentName);
    expect(afterPin.metadata?.uid).toBe(sharedDeploymentUid);
    expect(afterPin.spec?.replicas).toBe(replicasBefore);
    expect(
      afterPin.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();
    expect(await listRunningPodNames(multitenantCatalogId)).toEqual(podsBefore);

    // Sit out a full window with the sweeper running and nobody calling
    // anything. Only A asked to be pinned; B — and the shared pod both of them
    // are served by — survive on A's veto alone.
    await waitOutIdleWindow(vetoWindowStart);

    const vetoed = await readDeployment(sharedDeploymentName);
    expect(
      vetoed.spec?.replicas,
      "one install pinned `disabled` must keep the shared deployment awake for every install on it",
    ).toBe(replicasBefore);
    expect(
      vetoed.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();
    expect(
      vetoed.metadata?.annotations?.[MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION],
    ).toBeUndefined();
    expect(await listRunningPodNames(multitenantCatalogId)).toEqual(podsBefore);
    // The sweep evaluates the group every tick; it must not have "resolved"
    // the veto by editing anybody's row.
    const [stillPinnedA, stillInheritB] = await Promise.all([
      readInstall(request, installA.id),
      readInstall(request, installB.id),
    ]);
    expect(stillPinnedA.hibernationMode).toBe("disabled");
    expect(stillInheritB.hibernationMode).toBe("inherit");

    // The group write path: the registry's server settings dialog is
    // catalog-scoped, so its PUT must reach every install of the catalog —
    // including B, which the per-install write above deliberately did not.
    await setCatalogHibernationMode(request, multitenantCatalogId, "inherit");

    const [clearedA, clearedB] = await Promise.all([
      readInstall(request, installA.id),
      readInstall(request, installB.id),
    ]);
    expect(clearedA.hibernationMode).toBe("inherit");
    expect(clearedB.hibernationMode).toBe("inherit");

    // Same deployment, same idleness, nothing changed but the veto — so this
    // is what the wait above was measuring against. The annotation is the
    // platform's own record of the count it found.
    await expect
      .poll(() => readHibernationShape(sharedDeploymentName), {
        timeout: HIBERNATION_DEADLINE_MS,
        intervals: HIBERNATION_POLL_INTERVALS,
      })
      .toEqual({
        replicas: 0,
        hibernated: "true",
        preHibernationReplicas: String(replicasBefore),
      });

    // Nothing else may be swept for the rest of the spec.
    await setOrganizationHibernation(request, false);

    // Put the group back the way the remaining tests expect to find it. A
    // sleep the platform decided on is wakeable exactly like an injected one —
    // the wake is gated on neither the toggle (now off again) nor a mode.
    await expect(async () => {
      expect(await callTool(request, installB)).toBe(multitenantToolText);
    }).toPass({ timeout: 210_000, intervals: [5_000, 10_000] });

    await expect
      .poll(() => readHibernationShape(sharedDeploymentName), {
        timeout: 120_000,
        intervals: [2_000, 5_000],
      })
      .toEqual({
        replicas: replicasBefore,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });
    expect((await readDeployment(sharedDeploymentName)).metadata?.uid).toBe(
      sharedDeploymentUid,
    );
  });

  test("a custom-YAML deployment sleeps on its own replica count and wakes back to exactly that, not to one", async ({
    request,
  }) => {
    // A real sweep has to notice this deployment, then two pods have to come
    // back, each npm-installing the MCP SDK, after the wake's readiness budget.
    test.setTimeout(900_000);

    // The advanced YAML is what put 2 replicas here: the platform's generated
    // manifest asks for 1, and nothing else in the install path scales up. If
    // this were 1, everything below would hold for a platform that simply
    // hardcodes the default.
    const deployment = await readDeployment(customYamlDeploymentName);
    expect(deployment.spec?.replicas).toBe(CUSTOM_YAML_REPLICAS);
    await expect
      .poll(
        async () => (await listRunningPodNames(customYamlInstall.id)).length,
        { timeout: 120_000, intervals: [2_000, 5_000] },
      )
      .toBe(CUSTOM_YAML_REPLICAS);

    // The switch below is organization-wide, so the shared multitenant
    // deployment — awake, and idle since the previous test — has to be held
    // out of the sweep this test is arranging for its own fixture.
    await setCatalogHibernationMode(request, multitenantCatalogId, "disabled");
    // …and this one has to be let into it. It has served nothing since it was
    // installed, so its idle window elapsed long ago and the next sweep tick
    // after the switch is the one that sleeps it.
    await setCatalogHibernationMode(request, customYamlCatalogId, "inherit");
    await setOrganizationHibernation(request, true);

    // What the PLATFORM recorded when it slept this deployment, not what a
    // test wrote: a sweep that assumed the default single replica would
    // silently halve this server's capacity at the next wake, for good.
    await expect
      .poll(() => readHibernationShape(customYamlDeploymentName), {
        timeout: HIBERNATION_DEADLINE_MS,
        intervals: HIBERNATION_POLL_INTERVALS,
      })
      .toEqual({
        replicas: 0,
        hibernated: "true",
        preHibernationReplicas: String(CUSTOM_YAML_REPLICAS),
      });

    // The sweep has produced what this test came for; close it before waking
    // anything, and give the shared deployment its inherited mode back.
    await setOrganizationHibernation(request, false);
    await setCatalogHibernationMode(request, multitenantCatalogId, "inherit");

    await expect
      .poll(async () => countPods(customYamlInstall.id), {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBe(0);

    let customYamlToolText = "";
    await expect(async () => {
      customYamlToolText = await callTool(request, customYamlInstall);
      expect(customYamlToolText).toContain(
        `ARCHESTRA_TEST = ${CUSTOM_YAML_ENV_VALUE}`,
      );
    }).toPass({ timeout: 210_000, intervals: [5_000, 10_000] });

    // The wake reads the recorded count instead of assuming a single replica,
    // and only clears the annotations once the deployment is back up.
    await expect
      .poll(() => readHibernationShape(customYamlDeploymentName), {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toEqual({
        replicas: CUSTOM_YAML_REPLICAS,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });

    await expect
      .poll(
        async () => (await listRunningPodNames(customYamlInstall.id)).length,
        { timeout: 180_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toBe(CUSTOM_YAML_REPLICAS);

    expect(await callTool(request, customYamlInstall)).toBe(customYamlToolText);
  });

  test("hibernation mode is operational: the install rows carry it and no reinstall is owed", async ({
    request,
    makeApiRequest,
  }) => {
    const catalogBefore = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/internal_mcp_catalog/${multitenantCatalogId}`,
    });
    expect((await catalogBefore.json()).catalogReinstallRequired).toBe(false);
    const podsBefore = await listRunningPodNames(multitenantCatalogId);

    await setCatalogHibernationMode(request, multitenantCatalogId, "disabled");

    for (const install of [installA, installB]) {
      const row = await readInstall(request, install.id);
      // The mode is stored per install even though it was written per
      // catalog — that is what lets a single install be re-pinned later
      // without the catalog knowing.
      expect(row.hibernationMode).toBe("disabled");
      // Changing it alters nothing about how the server is configured or
      // deployed. Were it treated as configuration, these flags would demand a
      // re-provision — on a multitenant catalog that means recreating the pod
      // every install on it is using.
      expect(row.reinstallRequired).toBe(false);
      expect(row.reinstallReason).toBeNull();
    }

    const catalogAfter = await (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/internal_mcp_catalog/${multitenantCatalogId}`,
      })
    ).json();
    expect(catalogAfter.catalogReinstallRequired).toBe(false);
    // Not a catalog column: the row the PUT returns must not grow one.
    expect(catalogAfter.hibernationMode).toBeUndefined();

    const deployment = await readDeployment(sharedDeploymentName);
    expect(deployment.metadata?.uid).toBe(sharedDeploymentUid);
    expect(deployment.spec?.replicas).toBe(sharedReplicas);
    expect(
      deployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();
    expect(await listRunningPodNames(multitenantCatalogId)).toEqual(podsBefore);

    // Leave the group as it was found, so the afterAll uninstall does not run
    // against installs pinned awake.
    await setCatalogHibernationMode(request, multitenantCatalogId, "inherit");

    // The control for every `reinstallRequired: false` above: a catalog edit
    // that really does invalidate the installs — a newly required value only
    // the installer can supply — must move those same columns on those same
    // rows. Deliberately last: it leaves both installs owing a reinstall,
    // which only the afterAll's uninstall sees.
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/internal_mcp_catalog/${multitenantCatalogId}`,
      data: {
        localConfig: {
          ...MULTITENANT_LOCAL_CONFIG,
          environment: [
            ...MULTITENANT_LOCAL_CONFIG.environment,
            {
              key: "ARCHESTRA_TEST_PROMPTED",
              type: "plain_text",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      },
    });

    for (const install of [installA, installB]) {
      const row = await readInstall(request, install.id);
      expect(row.reinstallRequired).toBe(true);
      expect(row.reinstallReason).toBe("new-input");
      // An edit that does demand a reinstall still leaves the operational
      // field alone.
      expect(row.hibernationMode).toBe("inherit");
    }
  });
});
