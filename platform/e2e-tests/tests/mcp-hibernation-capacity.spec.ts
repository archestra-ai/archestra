// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { testMcpServerCommand } from "@archestra/shared/test-mcp-server";
import * as k8s from "@kubernetes/client-node";
import type { APIRequestContext } from "@playwright/test";
import {
  DEFAULT_TEAM_NAME,
  MCP_SERVER_NAMESPACE,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "../consts";
import {
  callMcpTool,
  findInstalledServer,
  getTeamTokenForProfile,
  waitForServerInstallation,
} from "../utils";
import { expect, test } from "./api-fixtures";
import { assertHibernationTimingProfile } from "./hibernation-timing";

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

/**
 * This spec gets its OWN catalog item and install rather than reusing the
 * shared `internal-dev-test-server`. Two of its tests deliberately break the
 * Deployment (unschedulable pod, unpullable image) and one restarts every
 * install of its catalog, so pointing any of that at the fixture other specs
 * share would fail them instead.
 */
const CATALOG_ITEM_NAME = "e2e-hibernation-capacity";
const RAW_TOOL_NAME = "print_archestra_test";
const TEST_ENV_VALUE = "hibernation-capacity-e2e";

/**
 * A CPU request no node in this suite's clusters can satisfy, so the scheduler
 * leaves the pod Pending/Unschedulable within seconds. Deterministic and fast
 * where waiting out an idle window is neither: the minimum accepted window is
 * 120 s and the default is 1800 s.
 */
const UNSCHEDULABLE_CPU_REQUEST = "1000";

/**
 * Syntactically valid, deliberately absent from every node. Paired with
 * `imagePullPolicy: Never` the kubelet reports `ErrImageNeverPull`, a terminal
 * container state — unlike `ErrImagePull`/`ImagePullBackOff`, which the
 * kubelet retries on its own and the runtime therefore classifies as
 * still-starting rather than broken.
 */
const UNPULLABLE_IMAGE = "archestra-e2e-missing-image:hibernation-capacity";

/**
 * MCP idle hibernation — the two external dependencies a scale-to-zero feature
 * newly depends on: cluster capacity at wake time, and the container registry.
 *
 * Like the happy-path spec, this one injects the hibernated shape directly onto
 * the Deployment (spec.replicas 0 plus both annotations, i.e. exactly the merge
 * patch `hibernate()` writes) and then exercises the REAL on-demand wake.
 * `ensureAwake()` is gated only on the K8s runtime being enabled — never on the
 * feature being on — so a sleeping deployment is always wakeable and no idle
 * timer has to elapse.
 *
 * The pairing is the point. A wake blocked by a full cluster must stay
 * retryable and resumable; a wake blocked by a genuinely broken pod must be
 * terminal. Either verdict on its own could be produced by code that always
 * answers the same way.
 */
test.describe("MCP idle hibernation - capacity and registry failure modes", () => {
  // Installing an MCP server, breaking its Deployment and waking it again is
  // well past the default 60 s. Individual tests raise this further: a single
  // wake that has to ride out the whole ready budget takes ~44 s on its own.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let appsApi: k8s.AppsV1Api;
  let coreApi: k8s.CoreV1Api;

  let catalogItemId: string;
  let serverId: string;
  let gatewayId: string;
  let teamToken: string;
  let toolName: string;
  let deploymentName: string;

  /** Container of the MCP pod template, as the cluster actually names it. */
  let containerName: string;
  /** Pod-template values every test must put back before the next one runs. */
  let originalImage: string;
  let originalPullPolicy: string;
  let originalCpuRequest: string;
  /** Replica count the Deployment runs at when awake. */
  let baselineReplicas: number;
  /** Tool output of the healthy server; every recovery must reproduce it. */
  let baselineToolText: string;
  /**
   * Registry-backed images use `IfNotPresent`; a bare (node-local) image name
   * resolves to the stricter `Never`. CI side-loads the MCP base image into the
   * Kind node under a bare tag on fork runs and pulls a registry-qualified tag
   * otherwise, so which of the two applies is an environment fact, not a choice.
   */
  let imageIsRegistryQualified: boolean;

  const readDeployment = () =>
    appsApi.readNamespacedDeployment({
      name: deploymentName,
      namespace: MCP_SERVER_NAMESPACE,
    });

  /** Undefined while a rollout has the Deployment momentarily unreadable. */
  const readContainer = async (): Promise<k8s.V1Container | undefined> => {
    try {
      const deployment = await readDeployment();
      return deployment.spec?.template?.spec?.containers?.[0];
    } catch {
      return undefined;
    }
  };

  const listDeploymentPods = async (): Promise<k8s.V1Pod[]> => {
    const pods = await coreApi.listNamespacedPod({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: "app=mcp-server",
    });
    return pods.items.filter((pod) =>
      pod.metadata?.name?.startsWith(`${deploymentName}-`),
    );
  };

  const listPodEvents = async (podName: string): Promise<k8s.CoreV1Event[]> => {
    const events = await coreApi.listNamespacedEvent({
      namespace: MCP_SERVER_NAMESPACE,
      fieldSelector: `involvedObject.name=${podName}`,
    });
    return events.items;
  };

  const readHibernationAnnotations = async (): Promise<{
    hibernated: string | undefined;
    preHibernationReplicas: string | undefined;
  }> => {
    const annotations = (await readDeployment()).metadata?.annotations ?? {};
    return {
      hibernated: annotations[MCP_HIBERNATED_ANNOTATION],
      preHibernationReplicas:
        annotations[MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION],
    };
  };

  /**
   * Strategic merge patch, so the single-element `containers` list is merged by
   * container name instead of replacing the whole array (which a JSON merge
   * patch would do, dropping env, args and volume mounts with it).
   */
  const patchContainer = async (
    patch: Omit<k8s.V1Container, "name">,
  ): Promise<void> => {
    await appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: MCP_SERVER_NAMESPACE,
        body: {
          spec: {
            template: {
              spec: { containers: [{ ...patch, name: containerName }] },
            },
          },
        } as k8s.V1Deployment,
      },
      k8s.setHeaderOptions(
        "Content-Type",
        k8s.PatchStrategy.StrategicMergePatch,
      ),
    );
  };

  /**
   * Exactly the merge patch `K8sDeployment.hibernate()` writes: replicas 0 and
   * both annotations in one patch, so they can never be observed out of sync.
   * Returns once the kubelet has actually torn the pod down — otherwise the
   * next call would "wake" a server that never stopped serving.
   */
  const applyHibernatedShape = async (): Promise<void> => {
    await appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: MCP_SERVER_NAMESPACE,
        body: {
          metadata: {
            annotations: {
              [MCP_HIBERNATED_ANNOTATION]: "true",
              [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]:
                String(baselineReplicas),
            },
          },
          spec: { replicas: 0 },
        },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );

    await expect
      .poll(async () => (await listDeploymentPods()).length, {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBe(0);
  };

  type ToolCallOutcome = { text: string; isError: boolean };

  /**
   * The wake's two failure verdicts come back as tool RESULTS carrying
   * `isError` and the message, while a call that never reaches the wake (a
   * stale pooled connection to a pod that is gone) throws. Both are outcomes
   * this spec inspects, so neither is allowed to abort a polling loop.
   */
  const callTestTool = async (
    request: APIRequestContext,
  ): Promise<ToolCallOutcome> => {
    try {
      const result = (await callMcpTool(request, {
        profileId: gatewayId,
        token: teamToken,
        toolName,
        timeoutMs: 120_000,
      })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const textContent = result.content.find((part) => part.type === "text");
      return {
        text: textContent?.text ?? "",
        isError: result.isError === true,
      };
    } catch (error) {
      return {
        text: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  };

  /**
   * Poll a tool call until the server answers with its real output. Absorbs the
   * seconds the runtime's deployment watch needs to notice an out-of-band scale
   * change (until it does, the manager's cached state still reads "running" and
   * ensureAwake takes its documented fast path) and the reconnect of the pooled
   * MCP client. A wake that cannot finish fails every attempt.
   */
  const expectToolCallToSucceed = async (
    request: APIRequestContext,
    timeout: number,
  ): Promise<void> => {
    await expect(async () => {
      const outcome = await callTestTool(request);
      expect(outcome.isError, `tool call still failing: ${outcome.text}`).toBe(
        false,
      );
      expect(outcome.text).toBe(baselineToolText);
    }).toPass({ timeout, intervals: [2_000, 5_000, 10_000] });
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
      // A cold install pulls the MCP base image and runs `npm install` in the
      // pod before the first tool call can be served.
      test.setTimeout(300_000);
      await assertHibernationTimingProfile({ request, makeApiRequest });

      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      appsApi = kc.makeApiClient(k8s.AppsV1Api);
      coreApi = kc.makeApiClient(k8s.CoreV1Api);

      const defaultTeam = await getTeamByName(request, DEFAULT_TEAM_NAME);

      // Deterministic name, so a run that died before its teardown leaves
      // something reusable rather than an accumulating pile of catalog items.
      const catalogResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/internal_mcp_catalog",
      });
      const catalogPayload = await catalogResponse.json();
      const catalogItems: Array<{ id: string; name: string }> = Array.isArray(
        catalogPayload,
      )
        ? catalogPayload
        : (catalogPayload?.data ?? []);
      const existingCatalogItem = catalogItems.find(
        (item) => item.name === CATALOG_ITEM_NAME,
      );
      if (existingCatalogItem) {
        catalogItemId = existingCatalogItem.id;
      } else {
        const createResponse = await createMcpCatalogItem(request, {
          name: CATALOG_ITEM_NAME,
          description:
            "Dedicated fixture for the MCP hibernation capacity and registry e2e spec.",
          serverType: "local",
          localConfig: {
            command: "sh",
            arguments: ["-c", testMcpServerCommand],
            transportType: "stdio",
            environment: [
              {
                key: "ARCHESTRA_TEST",
                type: "plain_text",
                promptOnInstallation: true,
                required: true,
                description: "Test value to print",
              },
            ],
          },
        });
        catalogItemId = (await createResponse.json()).id;
      }

      let testServer = await findInstalledServer(
        request,
        catalogItemId,
        defaultTeam.id,
      );
      if (!testServer) {
        const installResponse = await installMcpServer(request, {
          name: CATALOG_ITEM_NAME,
          catalogId: catalogItemId,
          scope: "team",
          teamId: defaultTeam.id,
          environmentValues: { ARCHESTRA_TEST: TEST_ENV_VALUE },
        });
        testServer = await installResponse.json();
      }
      if (!testServer) {
        throw new Error("MCP server should be installed at this point");
      }
      serverId = testServer.id;
      await waitForServerInstallation(request, serverId);

      // The organization-wide idle-hibernation toggle is ON while this suite
      // runs, and its sweeper scales idle deployments to zero on its own
      // schedule. Every test below drives the hibernated shape by hand and
      // needs the Deployment to stay exactly where it was put, so this install
      // takes the per-install veto that pins it permanently awake. The
      // catalog-scoped PUT is the write path for the whole catalog, which this
      // spec owns outright. Read back further down: a veto that did not persist
      // would leave this spec racing the sweeper.
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}`,
        data: { hibernationMode: "disabled" },
      });

      // A team-scoped MCP gateway, so the Default Team token can reach the
      // team-owned installation above.
      const gatewayResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `MCP Hibernation Capacity Gateway ${Date.now()}`,
          agentType: "mcp_gateway",
          scope: "team",
          teams: [defaultTeam.id],
        },
      });
      gatewayId = (await gatewayResponse.json()).id;

      let testTool: { id: string; name: string } | undefined;
      await expect
        .poll(
          async () => {
            const toolsResponse = await makeApiRequest({
              request,
              method: "get",
              urlSuffix: "/api/tools",
            });
            const tools: Array<{
              id: string;
              name: string;
              catalogId?: string | null;
            }> = await toolsResponse.json();
            testTool = tools.find(
              (tool) =>
                tool.catalogId === catalogItemId &&
                tool.name.endsWith(
                  `${MCP_SERVER_TOOL_NAME_SEPARATOR}${RAW_TOOL_NAME}`,
                ),
            );
            return Boolean(testTool);
          },
          { timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe(true);
      if (!testTool) {
        throw new Error(
          `Tool '${RAW_TOOL_NAME}' was never discovered for catalog ${CATALOG_ITEM_NAME}`,
        );
      }
      toolName = testTool.name;

      // Pin the assignment to this installation so the gateway always targets
      // the deployment this spec breaks.
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/agents/${gatewayId}/tools/${testTool.id}`,
        data: { mcpServerId: serverId },
      });
      await waitForAgentTool(request, gatewayId, toolName);

      teamToken = await getTeamTokenForProfile(request, DEFAULT_TEAM_NAME);

      const serverResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp_server/${serverId}`,
      });
      const installedServer = await serverResponse.json();
      deploymentName = installedServer.deploymentName;
      expect(
        deploymentName,
        "MCP server row must carry its frozen K8s deployment name",
      ).toBeTruthy();
      // The per-install veto set above, read back off the install row after the
      // rest of the setup has run over it: the veto has to be a persisted
      // property of the install for the sweeper to see it, not a request-scoped
      // one, and nothing below is trustworthy if the sweeper can still take
      // this deployment away mid-test.
      expect(
        installedServer.hibernationMode,
        "this install must be pinned awake before the tests start breaking its deployment",
      ).toBe("disabled");

      const deployment = await readDeployment();
      baselineReplicas = deployment.spec?.replicas ?? 1;
      expect(baselineReplicas).toBeGreaterThan(0);
      const container = deployment.spec?.template?.spec?.containers?.[0];
      expect(container?.name).toBeTruthy();
      expect(container?.image).toBeTruthy();
      expect(container?.imagePullPolicy).toBeTruthy();
      expect(container?.resources?.requests?.cpu).toBeTruthy();
      containerName = container?.name ?? "";
      originalImage = container?.image ?? "";
      originalPullPolicy = container?.imagePullPolicy ?? "";
      originalCpuRequest = container?.resources?.requests?.cpu ?? "";
      imageIsRegistryQualified =
        originalImage.includes("/") || originalImage.includes(".");

      // Everything below asserts against this exact string, so a "recovered"
      // server that answers with something else is not recovered.
      const baseline = await callTestTool(request);
      expect(baseline.isError, baseline.text).toBe(false);
      expect(baseline.text).toContain(`ARCHESTRA_TEST = ${TEST_ENV_VALUE}`);
      baselineToolText = baseline.text;
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

      // Teardown FIRST. The tests below deliberately leave the Deployment
      // unschedulable, pointed at an image that does not exist, or scaled to
      // zero — and the uninstall deletes that Deployment outright, which repairs
      // every one of those by removing the object. Repairing by hand first would
      // spend this hook's budget on a rollout that, after a test failed mid-way,
      // may never come up at all, and a hook that runs out of budget leaks the
      // install, its catalog item and the gateway into the rest of the run.
      if (gatewayId) await deleteAgent(request, gatewayId).catch(() => {});
      let deploymentRemoved = false;
      if (serverId) {
        deploymentRemoved = await uninstallMcpServer(request, serverId).then(
          () => true,
          () => false,
        );
      }
      if (catalogItemId) {
        await deleteMcpCatalogItem(request, catalogItemId).catch(() => {});
      }

      // Reached only when the uninstall did not go through: a Deployment this
      // spec broke must never outlive it, so put the pod template, the
      // annotations and the replica count back by hand. Deliberately not gated
      // on the server serving again — this is damage repair, and a rollout that
      // cannot finish must not hold the hook open.
      if (!deploymentRemoved && deploymentName && containerName) {
        try {
          await patchContainer({
            image: originalImage,
            imagePullPolicy: originalPullPolicy,
            resources: { requests: { cpu: originalCpuRequest } },
          });
          await appsApi.patchNamespacedDeployment(
            {
              name: deploymentName,
              namespace: MCP_SERVER_NAMESPACE,
              body: {
                metadata: {
                  annotations: {
                    // A merge-patch null deletes the key, exactly as
                    // completeWake() does.
                    [MCP_HIBERNATED_ANNOTATION]: null,
                    [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: null,
                  },
                },
                spec: { replicas: baselineReplicas },
              },
            } as unknown as Parameters<
              typeof appsApi.patchNamespacedDeployment
            >[0],
            k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
          );
        } catch {
          // The Deployment may have gone with a partially-successful uninstall.
        }
      }
    },
  );

  test("a wake the cluster cannot schedule stays retryable and recovers on its own", async ({
    request,
  }) => {
    // One wake attempt spends its entire ~44 s ready budget before it reports
    // capacity pressure, and the recovery at the end spends a second wake.
    test.setTimeout(400_000);

    await applyHibernatedShape();

    // Break scheduling while no pod exists, so the deployment goes straight
    // from asleep to awake-but-unplaceable with no rollout in between.
    await patchContainer({
      resources: { requests: { cpu: UNSCHEDULABLE_CPU_REQUEST } },
    });

    let outcome: ToolCallOutcome = { text: "", isError: false };
    await expect(async () => {
      outcome = await callTestTool(request);
      expect(outcome.isError, `expected a wake failure: ${outcome.text}`).toBe(
        true,
      );
      expect(outcome.text).toContain("no free capacity to schedule its pod");
    }).toPass({ timeout: 180_000, intervals: [2_000, 5_000, 10_000] });

    // A full cluster is a condition, not a defect: the caller must be told to
    // come back, and told what the scheduler itself said, rather than being
    // handed the do-not-retry verdict reserved for a verifiably broken pod.
    expect(outcome.text).toContain("waking from idle hibernation");
    expect(outcome.text).toContain("retry shortly");
    expect(outcome.text).toContain("Pod scheduling failed");
    expect(outcome.text).toMatch(/insufficient cpu|nodes are available/i);
    expect(outcome.text).not.toContain("retrying will not help");

    // Nothing half-woken: both annotations still on the Deployment is what
    // makes the next call resume this wake instead of starting a new one, and
    // what keeps the sweeper from re-hibernating a deployment mid-wake.
    expect(await readHibernationAnnotations()).toEqual({
      hibernated: "true",
      preHibernationReplicas: String(baselineReplicas),
    });

    // The pod is queued, not discarded — the scheduler places it the moment
    // capacity frees, with nobody having to intervene.
    const queuedPod = (await listDeploymentPods()).find(
      (pod) => pod.status?.phase === "Pending",
    );
    expect(
      queuedPod?.metadata?.name,
      "the wake's pod must still exist and still be Pending",
    ).toBeTruthy();
    const scheduledCondition = queuedPod?.status?.conditions?.find(
      (condition) => condition.type === "PodScheduled",
    );
    expect(scheduledCondition?.status).toBe("False");
    expect(scheduledCondition?.reason).toBe("Unschedulable");

    // The self-heal, and the reason capacity pressure must not be terminal: no
    // reinstall, no restart, no annotation surgery — capacity comes back and
    // the very next tool call finishes the wake that was left resumable.
    await patchContainer({
      resources: { requests: { cpu: originalCpuRequest } },
    });
    await expectToolCallToSucceed(request, 180_000);

    await expect
      .poll(readHibernationAnnotations, {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toEqual({ hibernated: undefined, preHibernationReplicas: undefined });
  });

  test("a wake whose image can never be pulled is reported as permanent, not as capacity pressure", async ({
    request,
  }) => {
    test.setTimeout(300_000);

    await applyHibernatedShape();

    // `Never` alongside an absent image is what makes this deterministic: the
    // kubelet reports ErrImageNeverPull immediately instead of retrying a
    // registry pull it would keep retrying forever.
    await patchContainer({
      image: UNPULLABLE_IMAGE,
      imagePullPolicy: "Never",
    });

    let outcome: ToolCallOutcome = { text: "", isError: false };
    await expect(async () => {
      outcome = await callTestTool(request);
      expect(outcome.isError, `expected a wake failure: ${outcome.text}`).toBe(
        true,
      );
      expect(outcome.text).toContain("retrying will not help");
    }).toPass({ timeout: 180_000, intervals: [2_000, 5_000, 10_000] });

    // The contrast that keeps the capacity test above honest: a pod that is
    // verifiably broken must NOT be dressed up as something to retry, or a
    // caller loops forever on a condition only an operator can clear.
    expect(outcome.text).toContain("ErrImageNeverPull");
    expect(outcome.text).not.toContain("retry shortly");
    expect(outcome.text).not.toContain("no free capacity");

    await patchContainer({
      image: originalImage,
      imagePullPolicy: originalPullPolicy,
    });
    await expectToolCallToSucceed(request, 180_000);

    // Even a wake that ended in a terminal failure must not strand the
    // annotations: once the deployment serves again they are gone, so the
    // server is an ordinary running server rather than a permanently
    // "hibernated"-looking one.
    await expect
      .poll(readHibernationAnnotations, {
        timeout: 90_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toEqual({ hibernated: undefined, preHibernationReplicas: undefined });
  });

  test("waking reuses the image already on the node and never asks the registry for it", async ({
    request,
  }) => {
    test.setTimeout(300_000);

    // The steady-state pull policy IS the wake's registry independence:
    // `Always` would turn every wake into a registry round-trip, so a registry
    // outage would keep hibernated servers asleep.
    const container = await readContainer();
    expect(container?.imagePullPolicy).not.toBe("Always");
    expect(container?.imagePullPolicy).toBe(
      imageIsRegistryQualified ? "IfNotPresent" : "Never",
    );

    await applyHibernatedShape();
    await expectToolCallToSucceed(request, 180_000);

    const wokenPod = (await listDeploymentPods()).find(
      (pod) => pod.status?.phase === "Running",
    );
    const wokenPodName = wokenPod?.metadata?.name;
    expect(
      wokenPodName,
      "the wake must have scheduled a Running pod",
    ).toBeTruthy();

    // Events land behind the pod's own status, so poll instead of reading once.
    // With no events visible for this pod at all, "the kubelet did not pull"
    // would be true of any pod, including one that pulled.
    let events: k8s.CoreV1Event[] = [];
    await expect
      .poll(
        async () => {
          events = await listPodEvents(wokenPodName ?? "");
          return events.some((event) =>
            ["Scheduled", "Created", "Started", "Pulled"].includes(
              event.reason ?? "",
            ),
          );
        },
        {
          message: `no scheduler/kubelet events visible for ${wokenPodName}`,
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        },
      )
      .toBe(true);

    // `Pulling` is emitted only when the kubelet actually goes to the registry.
    expect(
      events.map((event) => event.reason),
      "a wake must start from the node-cached image, not a registry pull",
    ).not.toContain("Pulling");

    // The kubelet emits `Pulled` for a cache hit as well as for a completed
    // download; only its message distinguishes the two, so assert on the
    // message rather than the reason.
    const pulledEvents = events.filter((event) => event.reason === "Pulled");
    for (const event of pulledEvents) {
      expect(event.message ?? "").toMatch(/already present on machine/i);
    }

    if (imageIsRegistryQualified) {
      // Under `IfNotPresent` the kubelet always reports which image it started
      // the container from, so requiring that report to exist is what keeps the
      // message assertion above from being an empty loop over a pod nothing was
      // ever recorded about.
      expect(
        pulledEvents.length,
        "the kubelet must have reported which image the woken pod started from",
      ).toBeGreaterThan(0);
    } else {
      // A node-local image is pinned to `Never`, which cannot reach a registry
      // at all, so here the evidence is structural rather than in the event
      // stream: a Running pod under `Never` means the node already held the
      // image, because the only other outcome is the terminal ErrImageNeverPull
      // the test above induces on purpose.
      expect(
        (await readContainer())?.imagePullPolicy,
        "a node-local image must still be pinned to the node after the wake",
      ).toBe("Never");
    }
  });

  test("the explicit refresh-image action rolls the pods and asks for a fresh pull", async ({
    request,
    makeApiRequest,
  }) => {
    test.setTimeout(300_000);

    // A bare (node-local) image name has no registry to pull from, so its pull
    // policy is `Never` with and without a refresh. There is no change to
    // observe, and asserting the value the container already carried would pass
    // whether or not the action did anything. CI side-loads the MCP base image
    // into the Kind node under a bare tag on fork runs, so this is a real
    // environment, not a hypothetical one.
    test.skip(
      !imageIsRegistryQualified,
      `MCP base image "${originalImage}" is node-local, so a refresh cannot change its pull policy`,
    );

    // The steady state the refresh has to move away from. Captured rather than
    // assumed: an environment already sitting on `Always` would make the poll
    // below pass on arrival.
    const policyBeforeRefresh = (await readContainer())?.imagePullPolicy;
    expect(
      policyBeforeRefresh,
      "steady state must be the registry-independent policy, or this test proves nothing",
    ).toBe("IfNotPresent");

    const podBeforeRefresh = (await listDeploymentPods()).find(
      (pod) => pod.status?.phase === "Running",
    )?.metadata?.name;
    expect(podBeforeRefresh).toBeTruthy();

    // The route takes no body, but the helper always sends the JSON
    // content-type — an explicit `{}` keeps that from arriving as a bare
    // `null` payload.
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}/refresh-image`,
      data: {},
    });

    // Freshness was moved OUT of the wake and INTO this action, so it — and
    // only it — must produce a spec that pulls. The assertion is the change:
    // `IfNotPresent` reuses whatever the node holds, `Always` is a registry
    // round-trip on every container start.
    await expect
      .poll(async () => (await readContainer())?.imagePullPolicy, {
        message: `refresh must move the pull policy off ${policyBeforeRefresh}`,
        timeout: 180_000,
        intervals: [2_000, 5_000],
      })
      .toBe("Always");

    // The pull only happens because the action replaces the running pod: a
    // refresh that changed the policy without rolling anything would leave the
    // stale image serving.
    await expect
      .poll(
        async () => {
          const running = (await listDeploymentPods()).filter(
            (pod) => pod.status?.phase === "Running",
          );
          return (
            running.length > 0 &&
            running.every((pod) => pod.metadata?.name !== podBeforeRefresh)
          );
        },
        { timeout: 180_000, intervals: [2_000, 5_000] },
      )
      .toBe(true);

    await expectToolCallToSucceed(request, 180_000);
  });
});
