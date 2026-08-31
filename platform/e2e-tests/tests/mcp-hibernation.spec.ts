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
import { expect, type TestFixtures, test } from "./api-fixtures";
import {
  assertHibernationTimingProfile,
  earliestLegalHibernationMs,
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

/**
 * This spec gets its OWN catalog item and install. It hibernates, scales,
 * annotates and wakes the Deployment behind it dozens of times, and one test
 * lets the PLATFORM scale it to zero — pointing any of that at a fixture other
 * specs share would make this spec's cluster surgery visible to them.
 */
const CATALOG_ITEM_NAME = "e2e-hibernation-lifecycle";
const RAW_TOOL_NAME = "print_archestra_test";
const TEST_ENV_VALUE = "hibernation-e2e";

/** The `makeApiRequest` fixture, for helpers that outlive one test callback. */
type MakeApiRequest = TestFixtures["makeApiRequest"];

/** Per-call HTTP budget for a gateway tool call made by this spec. */
const TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * How a caller is answered when the deployment behind its tool has no pod and
 * the platform does NOT hold it hibernated (`McpServerNotReadyError` in
 * clients/mcp-client.ts). Telling the two apart is the whole point of the
 * ownership tests: a deployment the platform considers asleep is answered with
 * `McpServerWakeError` — "waking from idle hibernation … retry shortly" —
 * or woken outright.
 */
const NOT_RUNNING_ERROR_PATTERN = /not running yet|not ready/i;
const HIBERNATION_WORDING_PATTERN = /hibernat|waking/i;

/** Callers fired simultaneously at one sleeping deployment. */
const CONCURRENT_WAKE_CALLERS = 4;

/** Replica count used to prove a wake restores what it found, not 1. */
const MULTI_REPLICA_COUNT = 2;

/**
 * Retry budget for "call until the server answers". Covers the wake itself
 * (~44 s) plus the fresh pod's own start-up.
 */
const SERVING_RETRY_TIMEOUT_MS = 150_000;
/** Same, for callers queued behind three others on a serialized stdio pod. */
const BURST_SERVING_RETRY_TIMEOUT_MS = 300_000;
const SERVING_RETRY_INTERVALS = [2_000, 5_000, 10_000];

/** Pods and deployment status are polled on this cadence throughout. */
const CLUSTER_POLL_INTERVALS = hibernationTiming.clusterPollIntervals;
const POD_SETTLE_TIMEOUT_MS = 90_000;

/**
 * Quiet period before the tool call that starts the idle clock. Both guards on
 * the persisted stamp are age-based — `stamp()` skips the write while its own
 * previous stamp is younger than the refresh interval, and `updateLastUsed`
 * skips a row it wrote inside the same interval — so a call made during a busy
 * stretch of this file can legitimately leave the column untouched. Going
 * quiet for longer than the interval is what makes the next call's stamp
 * certain to reach the database.
 */
const LAST_USED_QUIET_PERIOD_MS = hibernationTiming.quietPeriodMs;

/**
 * Earliest moment the platform is ALLOWED to hibernate an install after its
 * last tool call. Nothing may sleep before this; the sweep tick that notices
 * comes later still.
 */
const EARLIEST_LEGAL_HIBERNATION_MS = earliestLegalHibernationMs;

/**
 * When the awake-during-the-window check is taken: half the window, i.e. a
 * full 90 s before the deployment is even eligible to sleep. Wide enough that
 * clock skew between this runner and the cluster cannot turn a correct
 * platform into a red test, tight enough that a sweeper ignoring the window
 * (or subtracting instead of adding the grace) is already caught here.
 */
const EARLY_AWAKE_CHECK_MS = hibernationTiming.earlyAwakeCheckMs;

/**
 * Budget for watching the platform put an idle install to sleep, measured
 * from the awake check above: the rest of the window and its grace (90 s),
 * plus up to one sweep tick to notice (the sweeper runs every
 * min(window / 2, 60 s) = 60 s), plus a second tick in case the first is
 * skipped while a previous sweep is still in flight.
 */
const PLATFORM_HIBERNATION_TIMEOUT_MS = hibernationTiming.hibernationDeadlineMs;

/**
 * A Kubernetes merge patch, which deletes a key by sending null — something
 * the generated `V1Deployment` type cannot express.
 */
type DeploymentMergePatch = {
  metadata?: { annotations?: Record<string, string | null> };
  spec?: { replicas?: number };
};

/** The install row fields this spec reads back over the API. */
type InstallRow = {
  id: string;
  deploymentName: string;
  hibernationMode: string;
  lastUsedAt: string | null;
};

/**
 * MCP idle hibernation — the core lifecycle against a real Kubernetes cluster.
 *
 * Most tests here never wait out an idle window: they inject the hibernated
 * state directly onto the Deployment — spec.replicas 0 plus both annotations,
 * i.e. exactly the merge patch `hibernate()` writes — and then exercise the
 * REAL on-demand wake. `McpServerRuntimeManager.ensureAwake()` is gated only
 * on the K8s runtime being enabled, never on the sweeper or on the feature
 * being switched on: a deployment that is already asleep must always be
 * wakeable.
 *
 * The last test is the exception, and the reason the rest can take that
 * shortcut safely: with the organization toggle on for the whole file, it
 * lifts this install's own hibernation veto, leaves it genuinely idle, and
 * watches the PLATFORM write the sleeping state itself — the sweep, the window
 * arithmetic and the annotation writing that every injected state above stands
 * in for. Until then the veto is what keeps the armed sweeper out of the other
 * tests' way, which makes it load-bearing rather than decorative. Paying for
 * an idle window in wall-clock time is also why that one test carries
 * `@slow-window`, and why it is last: nothing here may depend on it.
 *
 * What runs end to end against a real API server and kubelet:
 *   sweepIdleDeployments -> hibernate (replicas 0 + both annotations)
 *   ensureAwake -> beginWake (restore replicas, annotations stay)
 *              -> waitForDeploymentReady (real pod scheduled + ready)
 *              -> completeWake (both annotations removed, state "running")
 * plus the corner cases that decide whether the feature is safe to leave on:
 * the warm path it must not disturb, repeat and simultaneous demand on one
 * sleeping deployment, a zero-replica deployment that belongs to somebody
 * else, an ownership marker removed behind the platform's back, a wake left
 * half-finished, and a deployment that slept with more than one replica.
 *
 * The cluster is the source of truth throughout — spec.replicas, the two
 * annotations, metadata.generation and the pods themselves — because that is
 * what this feature manipulates. `metadata.generation` is the churn counter:
 * on the Kubernetes versions this suite runs against (verified live on
 * v1.33), the API server bumps it on EVERY mutating write, metadata-only
 * patches included. It therefore counts the exact number of writes a
 * lifecycle takes: one for a hibernate (annotations + replicas in a single
 * patch), one for a scale-up, one for the annotation-clearing completeWake.
 */
test.describe("MCP idle hibernation - on-demand wake", () => {
  // Installing an MCP server, scaling it to zero and waking it again (the wake
  // alone budgets ~44s for readiness) is well past the default 60s.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let appsApi: k8s.AppsV1Api;
  let coreApi: k8s.CoreV1Api;

  let catalogItemId = "";
  let serverId = "";
  let gatewayId = "";
  let teamToken = "";
  let toolName = "";
  let deploymentName = "";
  /** Replica count the Deployment had before this spec hibernated it. */
  let preHibernationReplicas = 0;
  /** Pod serving the tool before hibernation; the wake must create a new one. */
  let preHibernationPodName = "";
  /** Tool output observed before hibernation; the woken server must repeat it. */
  let baselineToolText = "";
  /**
   * The organization-wide toggle as this spec found it. Recorded before the
   * value is changed, so `afterAll` can put it back on every path.
   */
  let organizationHibernationWasEnabled: boolean | undefined;

  const listDeploymentPods = async (): Promise<k8s.V1Pod[]> => {
    const pods = await coreApi.listNamespacedPod({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: "app=mcp-server",
    });
    return pods.items.filter((pod) =>
      pod.metadata?.name?.startsWith(`${deploymentName}-`),
    );
  };

  const runningPodNames = async (): Promise<string[]> =>
    (await listDeploymentPods())
      .filter((pod) => pod.status?.phase === "Running")
      .map((pod) => pod.metadata?.name ?? "")
      .sort();

  const readDeployment = () =>
    appsApi.readNamespacedDeployment({
      name: deploymentName,
      namespace: MCP_SERVER_NAMESPACE,
    });

  /**
   * Everything the hibernation contract is written in terms of, read in one
   * request so the four facts cannot be observed at different moments.
   */
  const readDeploymentFacts = async () => {
    const deployment = await readDeployment();
    const annotations = deployment.metadata?.annotations;
    return {
      replicas: deployment.spec?.replicas,
      generation: deployment.metadata?.generation,
      hibernated: annotations?.[MCP_HIBERNATED_ANNOTATION],
      preHibernationReplicas:
        annotations?.[MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION],
    };
  };

  /**
   * {@link readDeploymentFacts} without `generation`, for the assertions about
   * where the lifecycle ended up rather than about how much churn it took.
   */
  const readHibernationShape = async () => {
    const facts = await readDeploymentFacts();
    return {
      replicas: facts.replicas,
      hibernated: facts.hibernated,
      preHibernationReplicas: facts.preHibernationReplicas,
    };
  };

  const patchDeployment = (body: DeploymentMergePatch) =>
    appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: MCP_SERVER_NAMESPACE,
        body,
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );

  /** A scale with no ownership marker — an operator's or controller's move. */
  const scaleOutOfBand = (replicas: number) =>
    patchDeployment({ spec: { replicas } });

  const waitForPodCount = async (
    expected: number,
    timeoutMs = POD_SETTLE_TIMEOUT_MS,
  ) => {
    await expect
      .poll(async () => (await listDeploymentPods()).length, {
        timeout: timeoutMs,
        intervals: CLUSTER_POLL_INTERVALS,
      })
      .toBe(expected);
  };

  const waitForDeploymentAvailable = async (
    timeoutMs = POD_SETTLE_TIMEOUT_MS,
  ) => {
    await expect
      .poll(
        async () => (await readDeployment()).status?.availableReplicas ?? 0,
        { timeout: timeoutMs, intervals: CLUSTER_POLL_INTERVALS },
      )
      .toBeGreaterThan(0);
  };

  /**
   * Put the Deployment to sleep the way `K8sDeployment.hibernate()` does:
   * replicas 0 and both annotations in a SINGLE patch, so they can never be
   * observed out of sync. Returns once the cluster confirms the shape and the
   * kubelet has actually released the pod — otherwise a test would "wake" a
   * server that never stopped serving.
   *
   * Arrangement, not assertion: the checks here only refuse to hand a test a
   * deployment that is not really asleep.
   */
  const putToSleepOutOfBand = async (recordedReplicas: number) => {
    await patchDeployment({
      metadata: {
        annotations: {
          [MCP_HIBERNATED_ANNOTATION]: "true",
          [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: String(recordedReplicas),
        },
      },
      spec: { replicas: 0 },
    });

    const facts = await readDeploymentFacts();
    expect(facts.replicas, "fixture: the deployment must be scaled to 0").toBe(
      0,
    );
    expect(facts.hibernated, "fixture: the ownership marker must be set").toBe(
      "true",
    );
    expect(facts.preHibernationReplicas).toBe(String(recordedReplicas));

    await waitForPodCount(0);
    return facts;
  };

  /**
   * Back to an awake, unmarked deployment at the replica count this spec
   * found. A merge patch deletes an annotation by sending null.
   */
  const restoreRunningDeployment = async () => {
    await patchDeployment({
      metadata: {
        annotations: {
          [MCP_HIBERNATED_ANNOTATION]: null,
          [MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION]: null,
        },
      },
      spec: { replicas: preHibernationReplicas || 1 },
    });
    await waitForDeploymentAvailable();
  };

  /**
   * Identity of every event recording that a pod was created for this
   * deployment. Kubernetes writes one per pod — the message carries the pod
   * name, so repeats are never folded into a single counted event — which
   * makes the set difference across a window an exact scale-up count that
   * depends on no clock the test and the cluster could disagree about.
   */
  const podCreationEventUids = async (): Promise<Set<string>> => {
    const events = await coreApi.listNamespacedEvent({
      namespace: MCP_SERVER_NAMESPACE,
      fieldSelector: "involvedObject.kind=ReplicaSet",
    });
    return new Set(
      events.items
        .filter(
          (event) =>
            event.reason === "SuccessfulCreate" &&
            event.involvedObject.name?.startsWith(`${deploymentName}-`),
        )
        .map((event) => event.metadata?.uid ?? event.metadata?.name ?? ""),
    );
  };

  const newPodCreationsSince = async (before: Set<string>): Promise<number> => {
    const after = await podCreationEventUids();
    return [...after].filter((uid) => !before.has(uid)).length;
  };

  const readInstall = async (params: {
    request: APIRequestContext;
    makeApiRequest: MakeApiRequest;
  }): Promise<InstallRow> => {
    const response = await params.makeApiRequest({
      request: params.request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    return response.json();
  };

  /**
   * The per-install idle-hibernation override, written through the
   * catalog-scoped route that cascades it onto every install of the catalog
   * (this spec's catalog has exactly one). Verified on the install row rather
   * than on the catalog response, because the install row is what the sweeper
   * resolves the group's verdict from.
   */
  const setHibernationMode = async (params: {
    request: APIRequestContext;
    makeApiRequest: MakeApiRequest;
    mode: "inherit" | "enabled" | "disabled";
  }): Promise<void> => {
    await params.makeApiRequest({
      request: params.request,
      method: "put",
      urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}`,
      data: { hibernationMode: params.mode },
    });
    expect(
      (await readInstall(params)).hibernationMode,
      "the per-install hibernation override must be stored before it is relied on",
    ).toBe(params.mode);
  };

  const setOrganizationHibernation = async (params: {
    request: APIRequestContext;
    makeApiRequest: MakeApiRequest;
    enabled: boolean;
  }): Promise<void> => {
    const response = await params.makeApiRequest({
      request: params.request,
      method: "patch",
      urlSuffix: "/api/organization/mcp-settings",
      data: { mcpIdleHibernationEnabled: params.enabled },
    });
    expect((await response.json()).mcpIdleHibernationEnabled).toBe(
      params.enabled,
    );
  };

  /**
   * Outcome of a gateway tool call, failures included. A failed MCP tool call
   * is not a transport error: the gateway answers with an ordinary JSON-RPC
   * result carrying `isError` and the failure text, and that text is what
   * says whether the platform treated this deployment as hibernated.
   */
  const callToolOutcome = async (
    request: APIRequestContext,
  ): Promise<{ isError: boolean; text: string }> => {
    try {
      const result = (await callMcpTool(request, {
        profileId: gatewayId,
        token: teamToken,
        toolName,
        timeoutMs: TOOL_CALL_TIMEOUT_MS,
      })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return {
        isError: result.isError === true,
        text: result.content.find((part) => part.type === "text")?.text ?? "",
      };
    } catch (error) {
      return {
        isError: true,
        text: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const callTestTool = async (request: APIRequestContext): Promise<string> =>
    (await callToolOutcome(request)).text;

  /**
   * Call until the server answers with its real output. Ready is not the same
   * as serving: the fixture MCP server installs its dependencies inside the
   * fresh pod before it starts speaking. Every attempt re-enters the demand
   * path, so a broken wake chain fails all of them — nothing else scales this
   * deployment back up.
   */
  const callUntilServing = async (
    request: APIRequestContext,
    timeoutMs = SERVING_RETRY_TIMEOUT_MS,
  ): Promise<string> => {
    let text = "";
    await expect(async () => {
      text = await callTestTool(request);
      expect(text).toBe(baselineToolText);
    }).toPass({ timeout: timeoutMs, intervals: SERVING_RETRY_INTERVALS });
    return text;
  };

  /**
   * Serial mode fixes the ORDER of these tests, not that the earlier ones ran
   * at all: a `--grep` selecting one test runs it against fields the recorder
   * step never filled. Every test below patches the Deployment from facts that
   * step recorded, so state that never got recorded must stop the test here
   * rather than send `undefined`-derived replica counts and pod names to the
   * cluster.
   */
  const requireRecordedBaseline = () => {
    expect(
      baselineToolText,
      "the fixture-precondition test must have recorded the server's output first",
    ).not.toBe("");
    expect(
      preHibernationReplicas,
      "the fixture-precondition test must have recorded the awake replica count first",
    ).toBeGreaterThan(0);
  };

  /** Wait out the remainder of a wall-clock deadline, if any is left. */
  const sleepUntil = async (deadlineMs: number): Promise<void> => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  };

  test.beforeAll(
    async ({
      request,
      makeApiRequest,
      createMcpCatalogItem,
      installMcpServer,
      getOrganization,
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
            "Dedicated fixture for the MCP idle-hibernation lifecycle e2e spec.",
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

      // Pin this install awake, BEFORE the organization toggle below arms the
      // platform's own sweeper for the rest of this file. Every test except
      // the last one hand-injects, heals and asserts hibernation states on
      // this exact Deployment; without the pin the sweeper would be a second,
      // invisible writer racing them. With it, the per-install veto is under
      // test the whole time — it is the only thing keeping this deployment
      // awake through several minutes of idleness with the master switch on.
      await setHibernationMode({ request, makeApiRequest, mode: "disabled" });

      // The organization toggle is the master switch for the platform's own
      // hibernate path and it defaults to off, so the last test cannot
      // exercise a real sweep without it. Recorded BEFORE it is changed, so
      // afterAll can put an organization-wide setting back on every path.
      const organization = await (await getOrganization(request)).json();
      organizationHibernationWasEnabled =
        organization.mcpIdleHibernationEnabled === true;
      await setOrganizationHibernation({
        request,
        makeApiRequest,
        enabled: true,
      });

      // A team-scoped MCP gateway, so the Default Team token can reach the
      // team-owned installation above.
      const gatewayResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `MCP Hibernation Gateway ${Date.now()}`,
          agentType: "mcp_gateway",
          scope: "team",
          teams: [defaultTeam.id],
        },
      });
      gatewayId = (await gatewayResponse.json()).id;

      // Resolved from THIS install's catalog rather than hardcoded: the tool
      // name embeds the catalog name, and this spec owns its catalog.
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
      // the deployment this spec hibernates.
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/agents/${gatewayId}/tools/${testTool.id}`,
        data: { mcpServerId: serverId },
      });
      await waitForAgentTool(request, gatewayId, toolName);

      teamToken = await getTeamTokenForProfile(request, DEFAULT_TEAM_NAME);

      deploymentName = (await readInstall({ request, makeApiRequest }))
        .deploymentName;
      expect(
        deploymentName,
        "MCP server row must carry its frozen K8s deployment name",
      ).toBeTruthy();
    },
  );

  test.afterAll(
    async ({
      request,
      makeApiRequest,
      deleteAgent,
      uninstallMcpServer,
      deleteMcpCatalogItem,
    }) => {
      // Four API round trips and a Deployment deletion, any of which can be
      // slow on a loaded cluster — and this hook exists precisely for the runs
      // where something above already went wrong.
      test.setTimeout(300_000);

      // Organization-wide state first: it is the only thing this spec can
      // leave behind that changes how OTHER specs behave.
      if (organizationHibernationWasEnabled !== undefined) {
        await setOrganizationHibernation({
          request,
          makeApiRequest,
          enabled: organizationHibernationWasEnabled,
        }).catch(() => {});
      }

      // Then the resources this spec created, before any cluster repair: the
      // uninstall deletes the Deployment outright, so restoring it first would
      // spend the budget that has to cover the teardown on a workload that is
      // about to stop existing.
      if (gatewayId) await deleteAgent(request, gatewayId).catch(() => {});
      let uninstalled = false;
      if (serverId) {
        uninstalled = await uninstallMcpServer(request, serverId).then(
          () => true,
          () => false,
        );
      }
      if (catalogItemId) {
        await deleteMcpCatalogItem(request, catalogItemId).catch(() => {});
      }

      // Only an install that is still there has a Deployment worth handing
      // back — asleep, marked or resized is how a test that failed mid-cycle
      // leaves it, and nothing else would ever clean that up.
      if (!uninstalled && appsApi && deploymentName) {
        await restoreRunningDeployment().catch(() => {});
      }
    },
  );

  /**
   * A recorder step, deliberately not a claim about hibernation: every
   * assertion in it holds for any freshly installed MCP server. What it exists
   * for is the four values the tests after it patch the cluster from — the
   * output a woken server must repeat, the replica count a wake must restore,
   * the pod a wake must replace — and refusing to hand those on unobserved is
   * the only thing it guarantees.
   */
  test("fixture precondition: record the awake deployment's output, replicas and pod", async ({
    request,
  }) => {
    baselineToolText = await callTestTool(request);
    expect(baselineToolText).toContain(`ARCHESTRA_TEST = ${TEST_ENV_VALUE}`);

    const deployment = await readDeployment();
    preHibernationReplicas = deployment.spec?.replicas ?? 1;
    expect(preHibernationReplicas).toBeGreaterThan(0);
    expect(
      deployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();

    const pods = await listDeploymentPods();
    preHibernationPodName =
      pods.find((pod) => pod.status?.phase === "Running")?.metadata?.name ?? "";
    expect(preHibernationPodName).not.toBe("");
  });

  test("a call to an already-running deployment is served without touching its replicas", async ({
    request,
  }) => {
    requireRecordedBaseline();

    const before = await readDeploymentFacts();
    const podsBefore = await runningPodNames();
    const podCreationsBefore = await podCreationEventUids();

    const toolText = await callTestTool(request);

    expect(toolText).toBe(baselineToolText);
    // Nothing about the workload moved: same desired replicas, same
    // generation — so no scale patch reached the API server at all — no
    // annotations, no ReplicaSet churn, and the very same pod answered. A warm
    // call that quietly took the wake path could not leave all four unchanged.
    expect(await readDeploymentFacts()).toEqual(before);
    expect(await newPodCreationsSince(podCreationsBefore)).toBe(0);
    expect(await runningPodNames()).toEqual(podsBefore);
  });

  test("a tool call wakes the hibernated deployment, restoring its replicas and clearing both annotations", async ({
    request,
  }) => {
    // A pod to tear down, a wake, and a cold pod that installs its
    // dependencies before it answers.
    test.setTimeout(300_000);
    requireRecordedBaseline();

    const asleep = await putToSleepOutOfBand(preHibernationReplicas);

    // THE assertion that matters: with zero replicas and no pod, the demand
    // path must run the full wake (beginWake -> waitForDeploymentReady ->
    // completeWake) and still return the tool's real output.
    //
    // Retried only to absorb the seconds the runtime's deployment watch needs
    // to notice the out-of-band scale-down: until it does, the manager's
    // cached state still reads "running" and ensureAwake takes its documented
    // fast path during the watcher's bounded propagation window. A
    // broken wake chain fails every attempt — nothing else scales this
    // deployment back up, this install is pinned out of the sweeper's reach
    // and no restart is issued.
    await callUntilServing(request);

    // A genuinely new pod served it — the wake scheduled one, the old one is
    // not somehow still around. Comparing against a pod name that was never
    // recorded would pass against any pod list at all, so require it first.
    expect(
      preHibernationPodName,
      "the fixture-precondition test must have recorded the pod that served before the sleep",
    ).not.toBe("");
    const running = await runningPodNames();
    expect(running.length).toBeGreaterThan(0);
    expect(running).not.toContain(preHibernationPodName);

    // The finish-waking half of the same action. This shape is ordinary for a
    // running Deployment, but not from where this one started seconds ago:
    // `putToSleepOutOfBand` left it at replicas 0 with both annotations set,
    // and completeWake() is the only writer that turns THAT into the recorded
    // count with neither key present — the call above is the only thing that
    // touched it since. A regression (completeWake never running, or clearing
    // one key of the two) leaves every woken deployment permanently marked
    // hibernated: it reads back as "waking"/"hibernated" forever, the UI
    // reports a dormant server that is in fact serving, and the next sweep
    // finds a deployment it believes it already owns. Polled because
    // completeWake lands just behind the first answered call.
    await expect
      .poll(readHibernationShape, {
        timeout: 60_000,
        intervals: CLUSTER_POLL_INTERVALS,
      })
      .toEqual({
        replicas: preHibernationReplicas,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });
    // And it got there in exactly a wake's two writes — the scale-up and the
    // annotation-clearing completeWake, one generation each (the API server
    // counts metadata-only patches too). A wake that flapped the deployment
    // down and up again would show two more.
    expect((await readDeploymentFacts()).generation).toBe(
      (asleep.generation ?? 0) + 2,
    );
  });

  test("calls after a completed wake are served without waking anything a second time", async ({
    request,
  }) => {
    requireRecordedBaseline();

    const before = await readDeploymentFacts();
    const podsBefore = await runningPodNames();
    const podCreationsBefore = await podCreationEventUids();

    const first = await callTestTool(request);
    const second = await callTestTool(request);

    expect(first).toBe(baselineToolText);
    expect(second).toBe(first);
    // No spec change (generation), no ReplicaSet churn (no pod created), and
    // the same pod served both: the wake ran once and stayed done. A wake
    // that re-armed itself — completeWake not clearing the marker, or the
    // cached state falling back to "hibernated" — would scale here again.
    expect(await readDeploymentFacts()).toEqual(before);
    expect(await newPodCreationsSince(podCreationsBefore)).toBe(0);
    expect(await runningPodNames()).toEqual(podsBefore);
  });

  test("simultaneous calls to one hibernated deployment share a single wake", async ({
    request,
  }) => {
    // Four callers each ride out the wake and the cold pod behind it, and the
    // gateway serializes stdio calls per connection — the last one in the
    // queue can wait for all three others before its own call even starts.
    test.setTimeout(480_000);
    requireRecordedBaseline();

    const asleep = await putToSleepOutOfBand(preHibernationReplicas);
    // What the cluster looked like before any of the simultaneous callers
    // touched it.
    const generationWhileHibernated = asleep.generation ?? 0;
    const podCreationsBeforeBurst = await podCreationEventUids();

    const texts = await Promise.all(
      Array.from({ length: CONCURRENT_WAKE_CALLERS }, () =>
        callUntilServing(request, BURST_SERVING_RETRY_TIMEOUT_MS),
      ),
    );

    // Every caller got the server's real output, not a wake error.
    expect(texts).toEqual(
      Array.from({ length: CONCURRENT_WAKE_CALLERS }, () => baselineToolText),
    );

    const facts = await readDeploymentFacts();
    // Exactly one wake for the whole burst: one scale-up plus one
    // annotation-clearing completeWake — two generations — and one pod
    // created by its ReplicaSet. A wake per caller shows up as extra
    // generations, extra pod creations, or both.
    expect(facts.generation).toBe(generationWhileHibernated + 2);
    expect(await newPodCreationsSince(podCreationsBeforeBurst)).toBe(1);
    expect(await listDeploymentPods()).toHaveLength(preHibernationReplicas);
    expect(facts.replicas).toBe(preHibernationReplicas);
    expect(facts.hibernated).toBeUndefined();
    expect(facts.preHibernationReplicas).toBeUndefined();
  });

  test("a zero-replica deployment without the hibernation annotations is never claimed or woken", async ({
    request,
  }) => {
    // Two pod lifecycles back to back — tearing this one down and bringing it
    // back — each of which the kubelet is allowed to take its grace period
    // over, around a tool call that is allowed its full upstream budget.
    test.setTimeout(300_000);
    requireRecordedBaseline();

    // Somebody else's scale-to-zero: no ownership marker, so none of this is
    // the platform's business.
    await scaleOutOfBand(0);
    // Waiting out the pod also gives the runtime's deployment watch several
    // seconds to observe the scale-down and classify what it found.
    await waitForPodCount(0);

    const before = await readDeploymentFacts();
    expect(before.replicas).toBe(0);
    expect(before.hibernated).toBeUndefined();
    expect(before.preHibernationReplicas).toBeUndefined();

    const outcome = await callToolOutcome(request);

    // Pre-feature behaviour, unchanged: a call to a scaled-down server fails
    // as "not running". A platform that had adopted this deployment as
    // hibernated would answer in the wake's own retryable wording instead, or
    // would have scaled it back up and succeeded.
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(NOT_RUNNING_ERROR_PATTERN);
    expect(outcome.text).not.toMatch(HIBERNATION_WORDING_PATTERN);

    // And it stayed somebody else's: no marker written, no scale-up.
    expect(await readDeploymentFacts()).toEqual(before);
    expect(await listDeploymentPods()).toHaveLength(0);

    await restoreRunningDeployment();
  });

  test("removing the hibernation annotation out of band ends the platform's claim", async ({
    request,
  }) => {
    test.setTimeout(300_000);
    requireRecordedBaseline();

    // This wait is also the window in which the runtime's watch observes the
    // deployment asleep, so the marker below is taken away from a platform
    // that believes it is holding this one hibernated.
    await putToSleepOutOfBand(preHibernationReplicas);

    await patchDeployment({
      metadata: { annotations: { [MCP_HIBERNATED_ANNOTATION]: null } },
    });

    const before = await readDeploymentFacts();
    expect(before.hibernated).toBeUndefined();
    expect(before.replicas).toBe(0);

    const outcome = await callToolOutcome(request);

    // Converged on cluster truth: without the marker this deployment is no
    // longer ours to hold, so the call fails like any other scaled-down
    // server. A platform still reporting it hibernated answers in the wake's
    // retryable wording; one that woke it anyway scales a workload it does
    // not own.
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(NOT_RUNNING_ERROR_PATTERN);
    expect(outcome.text).not.toMatch(HIBERNATION_WORDING_PATTERN);

    expect(await readDeploymentFacts()).toEqual(before);
    expect(await listDeploymentPods()).toHaveLength(0);

    await restoreRunningDeployment();
  });

  test("a call finishes a half-woken deployment instead of starting a second wake", async ({
    request,
  }) => {
    test.setTimeout(360_000);
    requireRecordedBaseline();

    const asleep = await putToSleepOutOfBand(preHibernationReplicas);
    const podCreationsBefore = await podCreationEventUids();

    // Exactly what a wake that ran out of readiness budget leaves behind:
    // replicas restored, both annotations still on the object. The platform
    // reads that shape as "waking", and the next call must resume it — not
    // begin a second wake, and not refuse to act on a state it did not
    // itself enter.
    await scaleOutOfBand(preHibernationReplicas);
    const halfWoken = await readDeploymentFacts();
    expect(halfWoken.hibernated).toBe("true");
    expect(halfWoken.replicas).toBe(preHibernationReplicas);
    expect(halfWoken.generation).toBe((asleep.generation ?? 0) + 1);

    await callUntilServing(request);

    await expect
      .poll(readHibernationShape, {
        timeout: 60_000,
        intervals: CLUSTER_POLL_INTERVALS,
      })
      .toEqual({
        replicas: preHibernationReplicas,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });
    // Finished, not restarted: the resume adds exactly the annotation-clearing
    // completeWake write on top of the scale-up this test performed, and only
    // the pod that scale-up produced ever existed. A second wake would scale
    // the deployment again (two more generations for a down-and-up cycle) or
    // replace the pod.
    expect((await readDeploymentFacts()).generation).toBe(
      (halfWoken.generation ?? 0) + 1,
    );
    expect(await newPodCreationsSince(podCreationsBefore)).toBe(1);
  });

  test("waking restores the exact replica count the deployment slept with", async ({
    request,
  }) => {
    // Two pods to schedule, two to tear down, a wake, and a scale back to one
    // — every step a real kubelet timeline.
    test.setTimeout(480_000);
    requireRecordedBaseline();

    await scaleOutOfBand(MULTI_REPLICA_COUNT);
    await waitForPodCount(MULTI_REPLICA_COUNT);

    // hibernate() records whatever the deployment was running in the same
    // patch as the scale-to-zero, which is the only place the count survives.
    await putToSleepOutOfBand(MULTI_REPLICA_COUNT);

    await callUntilServing(request);

    // Precisely the count it slept with. A wake that resets to a single
    // replica silently shrinks every scaled-out MCP server the first time it
    // idles, and nothing in the product would ever scale it back.
    await expect
      .poll(readHibernationShape, {
        timeout: 60_000,
        intervals: CLUSTER_POLL_INTERVALS,
      })
      .toEqual({
        replicas: MULTI_REPLICA_COUNT,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });
    // And the cluster really runs that many pods, not just asks for them.
    await waitForPodCount(MULTI_REPLICA_COUNT);

    // Back to the size the rest of this file works at.
    await restoreRunningDeployment();
    await waitForPodCount(preHibernationReplicas);
  });

  /**
   * `@slow-window` marks a test whose runtime is dominated by sitting out a
   * real idle window rather than by anything it asserts. Nothing selects on
   * it inside this file: the tag exists for the suite runner, which excludes
   * these on the pre-merge run (`--grep-invert=@slow-window`) and includes
   * them on the scheduled full run. It is therefore only ever safe on a test
   * nothing after it depends on — this one is last in the file, and it hands
   * the install back pinned exactly as `beforeAll` left it.
   */
  test("the platform hibernates an install that has gone idle, and a call wakes it @slow-window", async ({
    request,
    makeApiRequest,
    getOrganization,
  }) => {
    // The one test that waits out a REAL idle window instead of injecting the
    // sleeping state, so it pays for the configured quiet period, a fresh
    // provable last-used stamp, an early guaranteed-awake check, then the
    // window's remainder plus a sweep tick before the platform acts, a pod
    // teardown, a full wake and a cold pod's start-up.
    test.setTimeout(1_140_000);
    requireRecordedBaseline();

    // Nothing below can happen on a deployment that does not offer the
    // feature: the sweep timer never starts, and every wait would simply run
    // out saying nothing about the product.
    const platformConfig = await (
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/config",
      })
    ).json();
    expect(
      platformConfig.features?.mcpIdleHibernationBetaEnabled,
      "this deployment does not offer idle hibernation, so no sweep can run",
    ).toBe(true);

    try {
      // The sweeper re-reads the organization toggle every tick, so assert the
      // value it will read rather than the PATCH beforeAll sent.
      const organization = await (await getOrganization(request)).json();
      expect(
        organization.mcpIdleHibernationEnabled,
        "the organization-wide master switch must be on for anything to sleep",
      ).toBe(true);

      // Still pinned awake while this test arranges its idle start, so the
      // quiet period below cannot itself be mistaken for idleness.
      await sleepUntil(Date.now() + LAST_USED_QUIET_PERIOD_MS);

      const lastUsedBefore = Date.parse(
        (await readInstall({ request, makeApiRequest })).lastUsedAt ?? "",
      );
      expect(await callTestTool(request)).toBe(baselineToolText);

      // From here on nothing in this test touches the server, so the platform
      // sees a genuinely idle install. Measured from AFTER the last call, so
      // the deadlines below can only ever be conservative.
      const idleSince = Date.now();

      // Demand is only demand if it was recorded: the sweep measures idleness
      // against this column (and an in-process watermark it cannot rely on
      // when the sweep runs somewhere other than the process that served the
      // call), so a tool call that never advanced it would leave the platform
      // free to hibernate a server that is being used. Polled with plain
      // reads — another tool call here would restart the idle clock.
      await expect
        .poll(
          async () =>
            Date.parse(
              (await readInstall({ request, makeApiRequest })).lastUsedAt ?? "",
            ),
          { timeout: 30_000, intervals: CLUSTER_POLL_INTERVALS },
        )
        .toBeGreaterThan(lastUsedBefore);

      // Only now lift this install's veto — the pin every other test in this
      // file leans on — so for the rest of this test it is the sweeper's
      // business. Nothing can have slept before this point, which is what
      // makes the awake assertion below a statement about the idle window
      // rather than about the pin.
      await setHibernationMode({ request, makeApiRequest, mode: "enabled" });

      const awake = await readDeploymentFacts();
      expect(awake.hibernated).toBeUndefined();
      const replicasBeforeSleep = awake.replicas ?? 0;
      expect(replicasBeforeSleep).toBeGreaterThan(0);

      // Well inside the configured window. A deployment already asleep here
      // means the idle arithmetic ignored the window or its demand-signal
      // staleness grace.
      await sleepUntil(idleSince + EARLY_AWAKE_CHECK_MS);
      const stillAwake = await readDeploymentFacts();
      expect(
        {
          replicas: stillAwake.replicas,
          hibernated: stillAwake.hibernated,
          preHibernationReplicas: stillAwake.preHibernationReplicas,
        },
        `hibernated less than ${EARLIEST_LEGAL_HIBERNATION_MS / 1000}s after its last tool call`,
      ).toEqual({
        replicas: replicasBeforeSleep,
        hibernated: undefined,
        preHibernationReplicas: undefined,
      });

      // The whole point of this test: NOTHING here writes the sleeping state.
      // The platform's own sweep does — scale to zero, both annotations, and
      // the replica count it found recorded so the wake has something to
      // restore. Every other test in this file stands in for this one patch.
      await expect
        .poll(readHibernationShape, {
          timeout: PLATFORM_HIBERNATION_TIMEOUT_MS,
          intervals: CLUSTER_POLL_INTERVALS,
        })
        .toEqual({
          replicas: 0,
          hibernated: "true",
          preHibernationReplicas: String(replicasBeforeSleep),
        });

      // One scale event across the whole idle period: hibernate() writes the
      // replicas and both annotations in a single patch. Counted from the
      // awake read above — the last moment anything but the sweeper could
      // have touched this Deployment — so more generations than one would
      // mean the sweeper scaled it more than once, or flapped it.
      const slept = await readDeploymentFacts();
      expect(slept.generation).toBe((stillAwake.generation ?? 0) + 1);

      // The saving IS the pod, so a "hibernated" deployment still running one
      // costs exactly as much as it did awake.
      await waitForPodCount(0);

      // And the round trip closes: demand alone brings it back, with both
      // annotations gone and the recorded replica count restored. A wake that
      // left either annotation behind would leave the server looking dormant
      // forever, and would make it ineligible for the next sweep.
      await callUntilServing(request);
      await expect
        .poll(readHibernationShape, {
          timeout: 90_000,
          intervals: CLUSTER_POLL_INTERVALS,
        })
        .toEqual({
          replicas: replicasBeforeSleep,
          hibernated: undefined,
          preHibernationReplicas: undefined,
        });
      await waitForDeploymentAvailable();
    } finally {
      // Pin it awake again the moment this test is done with it, whatever
      // happened: the organization toggle stays on until afterAll runs.
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}`,
        data: { hibernationMode: "disabled" },
      }).catch(() => {});
    }
  });
});
