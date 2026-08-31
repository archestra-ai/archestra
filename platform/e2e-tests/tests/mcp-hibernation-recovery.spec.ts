// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { testMcpServerCommand } from "@archestra/shared/test-mcp-server";
import * as k8s from "@kubernetes/client-node";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import {
  DEFAULT_TEAM_NAME,
  getE2eRequestUrl,
  MCP_SERVER_NAMESPACE,
  UI_BASE_URL,
  WIREMOCK_INTERNAL_URL,
} from "../consts";
import {
  callMcpTool,
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
 * Container name in the generated Deployment (k8s-yaml-generator.ts). Needed
 * so the wedge below can be a strategic-merge patch that swaps ONLY the image:
 * a plain merge patch replaces the whole `containers` list and would destroy
 * the command and env the recovery is supposed to restore.
 */
const MCP_CONTAINER_NAME = "mcp-server";

/**
 * An image reference that can never resolve: `.invalid` is reserved by RFC
 * 6761 and never resolves in DNS, so the pull fails on every kubelet retry
 * regardless of what is cached on the node. MCP pods run `imagePullPolicy:
 * IfNotPresent`, so nothing else about the pod spec has to be broken — the
 * image is simply not there and cannot be fetched.
 */
const UNPULLABLE_WEDGE_IMAGE =
  "registry.archestra-e2e.invalid/hibernation-wedge:nonexistent";

/**
 * Container waiting reasons the kubelet reports for an image it cannot fetch.
 * The platform treats both as transient (the kubelet retries the pull on its
 * own), which is exactly why a wake onto {@link UNPULLABLE_WEDGE_IMAGE} runs
 * out its readiness budget instead of failing fast.
 */
const IMAGE_PULL_FAILURE_REASONS = ["ErrImagePull", "ImagePullBackOff"];

/**
 * How a wake that ran and could not finish reaches the caller:
 * `McpServerWakeError` (hibernation.ee.ts) phrases it for the agent and
 * mcp-client returns it as the tool result's text. Matched in full on purpose
 * — it is what separates the failure this spec arranges from every other way a
 * tool call can fail (an unknown tool, an expired token, a gateway that never
 * reached the server), and from the OTHER detail this same error carries
 * ("the cluster has no free capacity…"), which describes a full cluster rather
 * than a deployment that can never pull its image.
 */
const WAKE_DID_NOT_FINISH_PATTERN =
  /is waking from idle hibernation but did not become ready in time; retry shortly/i;

/**
 * Emitted by `assertActionTransition()` (hibernation-state-machine.ee.ts) when a
 * caller asks for a lifecycle move the transition table forbids. The record
 * carries `deploymentName`, which is what makes a refusal attributable to the
 * spec that caused it.
 */
const ILLEGAL_TRANSITION_LOG_MESSAGE =
  "Refused an illegal MCP hibernation state transition";

/** How the platform's own pod is labelled in the Kind/Helm e2e environment. */
const PLATFORM_POD_LABEL_SELECTOR = "app.kubernetes.io/name=archestra-platform";
const PLATFORM_CONTAINER_NAME = "archestra-platform";

const TEST_ENV_VALUE = "hibernation-recovery-e2e";
const TEST_TOOL_SUFFIX = "print_archestra_test";

/** Per-call HTTP budget for a gateway tool call made by this spec. */
const TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * How long the wedged server is given to prove it cannot rescue itself. One
 * failed wake costs its whole readiness budget (22 attempts x 2 s) before it
 * reports anything, and the first call after an out-of-band scale-down can
 * still be answered from the runtime's cached state — so the budget is sized
 * for several complete attempts, not one.
 */
const WEDGED_WAKE_ATTEMPT_BUDGET_MS = 240_000;

/** Retry budget for "call the tool until the rebuilt server answers". */
const SERVING_RETRY_TIMEOUT_MS = 150_000;
const SERVING_RETRY_INTERVALS = [2_000, 5_000, 10_000];

/** Cluster objects are polled on this cadence throughout. */
const CLUSTER_POLL_INTERVALS = [1_000, 2_000, 5_000];

/**
 * Administrator recovery — `POST /api/mcp_server/:id/hard-reset` against a
 * real cluster.
 *
 * The promise under test is the one that makes idle hibernation safe to ship:
 * a server that has wedged itself mid-lifecycle can always be brought back
 * from inside the product by someone holding an admin role, with no kubectl,
 * no database access and no engineer.
 *
 * The wedge is produced, not simulated. The Deployment is put into the exact
 * shape `hibernate()` writes (replicas 0 plus both annotations, one patch) AND
 * pointed at an image that can never be pulled, so every wake runs the real
 * code path and every wake genuinely fails. Waiting out an idle window is not
 * an option in CI — the minimum configurable window is 120 s and the default
 * is 1800 s — and on-demand wake is not gated on the sweeper anyway, so
 * injecting the slept shape reaches exactly the code an idle sweep would have.
 *
 * Everything here is spec-owned: its own catalog item, its own installation,
 * therefore its own physical Deployment. The sibling hibernation specs run in
 * the same Playwright project and share the internal-dev-test-server
 * installation — pointing THAT deployment at a broken image would fail them.
 *
 * The install is pinned `hibernationMode: "disabled"` in `beforeAll`. That is
 * not a way around the feature: on-demand wake is deliberately not gated on
 * the mode, so everything below still runs the real wake path. It only stops
 * the organization's own sweeper — enabled cluster-wide, on a 120 s idle
 * window — from hibernating a deployment mid-test while this spec is holding
 * it in a state it arranged by hand.
 */
test.describe("MCP hibernation - administrator recovery", () => {
  // Serial, because each test hands the next a cluster state it set up. The
  // budget is per test and deliberately far past the default 60s: a single
  // hard reset tears the Deployment down, recreates it and waits for a real
  // pod to become Ready, and a wake that cannot finish burns its own ~44s
  // readiness budget (up to the 120s attempt deadline) before it gives up.
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  let appsApi: k8s.AppsV1Api;
  let coreApi: k8s.CoreV1Api;

  let catalogId: string;
  let serverId: string;
  let gatewayId: string;
  let toolName: string;
  let teamToken: string;
  let deploymentName: string;
  /** Trailing id segment of `mcp-<slug>-<id8>`; identifies orphans by name. */
  let deploymentNameSuffix: string;
  /** Remote install used to prove the route refuses what it cannot reset. */
  let remoteServerId: string | undefined;
  let remoteCatalogId: string | undefined;

  /** Healthy shape, captured before anything is broken. */
  let baselineReplicas: number;
  let baselineToolText: string;
  let baselineDeploymentUid: string | undefined;
  /** Services carrying this deployment's id before any reset ran. */
  let baselineServiceNames: string[] = [];

  /** Start of the log window this spec may make claims about. */
  let specStartedAtMs = Date.now();

  const readDeployment = () =>
    appsApi.readNamespacedDeployment({
      name: deploymentName,
      namespace: MCP_SERVER_NAMESPACE,
    });

  /** `uid` of the live Deployment, or `absent` while it does not exist. */
  const readDeploymentUid = async (): Promise<string> => {
    try {
      const deployment = await readDeployment();
      return deployment.metadata?.uid ?? "unknown";
    } catch {
      return "absent";
    }
  };

  const listDeploymentPods = async (): Promise<k8s.V1Pod[]> => {
    const pods = await coreApi.listNamespacedPod({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: `mcp-server-id=${serverId}`,
    });
    return pods.items;
  };

  /** Every Deployment the platform owns for this install, by name. */
  const listOwnedDeploymentNames = async (): Promise<string[]> => {
    const deployments = await appsApi.listNamespacedDeployment({
      namespace: MCP_SERVER_NAMESPACE,
      labelSelector: `mcp-server-id=${serverId}`,
    });
    return deployments.items
      .map((item) => item.metadata?.name ?? "")
      .filter(Boolean)
      .sort();
  };

  /**
   * Services are matched by name rather than by label: the platform only
   * creates one for streamable-http servers, so for this stdio install any
   * Service carrying the deployment's id at all is already an orphan.
   */
  const listOwnedServiceNames = async (): Promise<string[]> => {
    const services = await coreApi.listNamespacedService({
      namespace: MCP_SERVER_NAMESPACE,
    });
    return services.items
      .map((item) => item.metadata?.name ?? "")
      .filter((name) => name.includes(deploymentNameSuffix))
      .sort();
  };

  /**
   * Identity of every event recording that a pod was created for this
   * deployment. Kubernetes writes one per pod — the message carries the pod
   * name, so repeats are never folded into a single counted event — which
   * makes the set difference across a window an exact count of how many times
   * this deployment was rebuilt, on evidence the cluster keeps rather than
   * evidence a test happened to be looking when it appeared.
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

  /**
   * Outcome of a gateway tool call, failures included. A failed MCP tool call
   * is not a transport error: the gateway answers with an ordinary JSON-RPC
   * result carrying `isError` and the failure text, and that text is what says
   * WHICH failure this was — the difference between a wake that ran and could
   * not finish and a call that never reached the wake at all.
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
   * fresh pod before it starts speaking.
   */
  const callUntilServing = async (
    request: APIRequestContext,
  ): Promise<void> => {
    await expect(async () => {
      expect(await callTestTool(request)).toBe(baselineToolText);
    }).toPass({
      timeout: SERVING_RETRY_TIMEOUT_MS,
      intervals: SERVING_RETRY_INTERVALS,
    });
  };

  /**
   * Serial mode fixes the ORDER of these tests, not that the earlier ones ran
   * at all: a `--grep` selecting one test runs it against fields the recorder
   * step never filled. Every test below either patches the Deployment from
   * what that step recorded or compares against it, so an unrecorded value has
   * to stop the test here rather than reach the cluster as a
   * `String(undefined)` replica count, or turn a uid comparison into one that
   * holds no matter what the platform did.
   */
  const requireRecordedBaseline = (): void => {
    expect(
      baselineToolText,
      "the fixture-precondition test must have recorded the server's output first",
    ).toContain(`ARCHESTRA_TEST = ${TEST_ENV_VALUE}`);
    expect(
      baselineReplicas,
      "the fixture-precondition test must have recorded the awake replica count first",
    ).toBeGreaterThan(0);
    expect(
      baselineDeploymentUid,
      "the fixture-precondition test must have recorded the Deployment's identity first",
    ).toBeTruthy();
  };

  /**
   * Raw call, so a refusal can be asserted on its status. The shared
   * `makeApiRequest` fixture re-authenticates the caller as admin on a 403,
   * which would silently destroy the point of the authorization test.
   */
  const hardReset = (
    request: APIRequestContext,
    id: string = serverId,
  ): Promise<APIResponse> =>
    request.post(getE2eRequestUrl(`/api/mcp_server/${id}/hard-reset`), {
      headers: { "Content-Type": "application/json", Origin: UI_BASE_URL },
      data: {},
      timeout: 170_000,
      failOnStatusCode: false,
    });

  const readInstallStatus = async (
    request: APIRequestContext,
  ): Promise<string> => {
    const response = await request.get(
      getE2eRequestUrl(`/api/mcp_server/${serverId}`),
      { headers: { Origin: UI_BASE_URL }, failOnStatusCode: true },
    );
    return (await response.json()).localInstallationStatus as string;
  };

  /**
   * The hard-reset route has two HONEST response shapes: a reset that fits
   * the 20s reply budget answers `completed` with the rebuild verdict inline;
   * one that outlives it — routine on a loaded runner, and guaranteed for a
   * teardown whose pod ignores SIGTERM — answers `in-progress` with no
   * verdict at all, and the outcome lands on the install status instead.
   * Asserting the inline verdict unconditionally fails every slow run by
   * design; these two helpers assert what each shape actually promises, and
   * then read the verdict from the channel it always reaches.
   */
  const expectHardResetReport = (result: {
    status?: string;
    mcpServerId?: string;
    physicalDeployment?: string;
    resetServerIds?: string[];
    rebuild?: unknown;
  }): void => {
    expect(result.mcpServerId).toBe(serverId);
    expect(result.physicalDeployment).toBe(
      `${MCP_SERVER_NAMESPACE}/${deploymentName}`,
    );
    expect(result.resetServerIds).toContain(serverId);
    if (result.status === "completed") {
      expect(
        result.rebuild,
        `the rebuilt deployment did not come up: ${JSON.stringify(result.rebuild)}`,
      ).toEqual({ outcome: "ready" });
    } else {
      expect(result.status).toBe("in-progress");
    }
  };

  const awaitHardResetRecovered = async (
    request: APIRequestContext,
  ): Promise<void> => {
    await expect
      .poll(() => readInstallStatus(request), {
        timeout: 150_000,
        intervals: CLUSTER_POLL_INTERVALS,
      })
      .not.toBe("pending");
    expect(
      await readInstallStatus(request),
      "the reset's durable verdict on the install row must be a recovery",
    ).toBe("success");
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
      // A cold install runs `npm install` for the MCP SDK inside the pod
      // before the server can answer anything, which alone can approach the
      // per-test budget. Only this hook needs the extra room.
      test.setTimeout(420_000);
      specStartedAtMs = Date.now();
      await assertHibernationTimingProfile({ request, makeApiRequest });

      const kc = new k8s.KubeConfig();
      kc.loadFromDefault();
      appsApi = kc.makeApiClient(k8s.AppsV1Api);
      coreApi = kc.makeApiClient(k8s.CoreV1Api);

      const defaultTeam = await getTeamByName(request, DEFAULT_TEAM_NAME);

      // Dedicated catalog item and installation: this spec deliberately breaks
      // the deployment it targets, so it must not share one with any other
      // spec in this project.
      const catalogResponse = await createMcpCatalogItem(request, {
        name: `e2e-hibernation-recovery-${Date.now()}`,
        description:
          "Dedicated fixture for the MCP hibernation hard-reset e2e spec.",
        serverType: "local",
        localConfig: {
          command: "sh",
          arguments: ["-c", testMcpServerCommand.replace(/\n/g, " ")],
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
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      const installResponse = await installMcpServer(request, {
        name: catalogItem.name,
        catalogId: catalogItem.id,
        scope: "team",
        teamId: defaultTeam.id,
        environmentValues: { ARCHESTRA_TEST: TEST_ENV_VALUE },
      });
      serverId = (await installResponse.json()).id;
      await waitForServerInstallation(request, serverId);

      // The organization's idle-hibernation toggle is ON in this cluster and
      // the idle window is short, while this spec spends whole tests holding
      // its deployment in states it built by hand — asleep on an image that
      // can never be pulled, half-woken, torn down and rebuilt. A sweep
      // landing inside one of those would move the cluster underneath the
      // assertions. `disabled` is the per-install veto over the organization
      // toggle, and it is also what an operator burned by hibernation reaches
      // for, so the tests below run against a realistically pinned install.
      // Written through the catalog route because that is the registry's write
      // path for the override and this catalog item has exactly ONE
      // installation — the per-install alternative is the reinstall route,
      // which would restart the deployment as a side effect.
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/internal_mcp_catalog/${catalogId}`,
        data: { hibernationMode: "disabled" },
      });

      // A team-scoped MCP gateway, so the Default Team token can reach the
      // team-owned installation above.
      const gatewayResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `MCP Hibernation Recovery Gateway ${Date.now()}`,
          agentType: "mcp_gateway",
          scope: "team",
          teams: [defaultTeam.id],
        },
      });
      gatewayId = (await gatewayResponse.json()).id;

      // Tool names embed the catalog name, which is generated above — resolve
      // the real one from the server instead of reconstructing the slug.
      let testTool: { id: string; name: string } | undefined;
      await expect
        .poll(
          async () => {
            const toolsResponse = await makeApiRequest({
              request,
              method: "get",
              urlSuffix: `/api/mcp_server/${serverId}/tools`,
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
        throw new Error("Fixture server exposed no print_archestra_test tool");
      }
      toolName = testTool.name;

      // Pin the assignment to this installation so the gateway always targets
      // the deployment this spec wedges.
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
      const server = await serverResponse.json();
      deploymentName = server.deploymentName;
      expect(
        deploymentName,
        "MCP server row must carry its frozen K8s deployment name",
      ).toBeTruthy();
      expect(
        server.hibernationMode,
        "fixture precondition: this install must be pinned awake before anything below runs",
      ).toBe("disabled");
      deploymentNameSuffix = deploymentName.slice(
        deploymentName.lastIndexOf("-") + 1,
      );
    },
  );

  test.afterAll(async ({ request, deleteAgent, uninstallMcpServer }) => {
    test.setTimeout(300_000);

    if (gatewayId) await deleteAgent(request, gatewayId).catch(() => {});
    if (serverId) await uninstallMcpServer(request, serverId).catch(() => {});
    if (remoteServerId) {
      await uninstallMcpServer(request, remoteServerId).catch(() => {});
    }
    for (const id of [catalogId, remoteCatalogId]) {
      if (!id) continue;
      await request
        .delete(getE2eRequestUrl(`/api/internal_mcp_catalog/${id}`), {
          headers: { Origin: UI_BASE_URL },
          failOnStatusCode: false,
        })
        .catch(() => {});
    }

    // Uninstall is the normal path and takes the Deployment with it. If it did
    // not (the spec failed early, or the row and the cluster disagree), delete
    // the Deployment directly: a zero-replica or image-pull-wedged workload
    // left behind would consume scheduler capacity for every later spec.
    if (!deploymentName || !appsApi) return;
    const deadlineMs = Date.now() + 60_000;
    while (Date.now() < deadlineMs) {
      if ((await readDeploymentUid()) === "absent") return;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    await appsApi
      .deleteNamespacedDeployment({
        name: deploymentName,
        namespace: MCP_SERVER_NAMESPACE,
      })
      .catch(() => {});
  });

  /**
   * A recorder step, deliberately not a claim about hibernation or recovery:
   * every assertion in it holds for any freshly installed MCP server. What it
   * exists for is the healthy shape the tests after it wedge, destroy and
   * rebuild against — the output a recovered server must reproduce, the
   * replica count a wake must restore, the Deployment identity a hard reset
   * must replace, the Services it must not leave behind — and refusing to hand
   * those on unobserved is the only thing it guarantees.
   */
  test("fixture precondition: record the healthy deployment's output, replicas, identity and Services", async ({
    request,
  }) => {
    baselineToolText = await callTestTool(request);
    expect(baselineToolText).toContain(`ARCHESTRA_TEST = ${TEST_ENV_VALUE}`);

    const deployment = await readDeployment();
    baselineReplicas = deployment.spec?.replicas ?? 1;
    baselineDeploymentUid = deployment.metadata?.uid;
    expect(baselineReplicas).toBeGreaterThan(0);
    expect(baselineDeploymentUid).toBeTruthy();
    expect(
      deployment.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();

    baselineServiceNames = await listOwnedServiceNames();
  });

  test("a server hibernated onto an unpullable image cannot recover on its own", async ({
    request,
  }) => {
    // Two pod lifecycles (the running pod torn down, a replacement scheduled
    // that can never pull) around at least one COMPLETE wake attempt, which
    // spends its whole readiness budget before it reports anything.
    test.setTimeout(420_000);
    requireRecordedBaseline();

    // Strategic merge so `containers` merges by name: only the image changes,
    // and the command, env and stdio wiring the recovery must restore survive.
    await appsApi.patchNamespacedDeployment(
      {
        name: deploymentName,
        namespace: MCP_SERVER_NAMESPACE,
        body: {
          spec: {
            template: {
              spec: {
                containers: [
                  { name: MCP_CONTAINER_NAME, image: UNPULLABLE_WEDGE_IMAGE },
                ],
              },
            },
          },
        },
      },
      k8s.setHeaderOptions(
        "Content-Type",
        k8s.PatchStrategy.StrategicMergePatch,
      ),
    );

    // Exactly the merge patch `K8sDeployment.hibernate()` writes: replicas 0
    // and both annotations in one patch, so they can never be observed out of
    // sync. From here the server is asleep AND unable to ever wake.
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

    // The kubelet must actually tear the pod down, otherwise the tool call
    // below would be answered by a server that never stopped serving.
    await expect
      .poll(async () => (await listDeploymentPods()).length, {
        timeout: 90_000,
        intervals: CLUSTER_POLL_INTERVALS,
      })
      .toBe(0);

    // On-demand wake is the only thing that could rescue this, and it cannot:
    // the replacement pod can never pull its image. Called repeatedly because
    // the FIRST call after an out-of-band scale-down can still be answered
    // from the runtime's cached state — a "not running yet" that never reached
    // the wake at all — and that must not be mistaken for the failure this
    // test is about. Every later call re-enters the demand path, so the loop
    // ends on the wake's own failure or on nothing.
    const attemptDeadlineMs = Date.now() + WEDGED_WAKE_ATTEMPT_BUDGET_MS;
    let lastFailureText = "";
    let wakeReportedFailure = false;
    while (!wakeReportedFailure && Date.now() < attemptDeadlineMs) {
      const outcome = await callToolOutcome(request);
      lastFailureText = outcome.text;
      // Never acceptable on ANY attempt: the tool answering for real would
      // mean the call was served from a pod that cannot exist.
      expect(
        outcome.text,
        "a deployment whose image can never be pulled must not answer tool calls",
      ).not.toContain(`ARCHESTRA_TEST = ${TEST_ENV_VALUE}`);
      expect(outcome.isError).toBe(true);
      wakeReportedFailure = WAKE_DID_NOT_FINISH_PATTERN.test(outcome.text);
      // A call answered from cached state comes back in milliseconds; pace the
      // retries so those cannot spin against the gateway while the runtime's
      // deployment watch catches up with the scale-down.
      if (!wakeReportedFailure) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    expect(
      wakeReportedFailure,
      `the platform never reported a wake it could not finish; last tool failure was: ${lastFailureText}`,
    ).toBe(true);

    // The wake was genuinely ATTEMPTED, not merely reported: the platform
    // scaled the sleeping deployment back up to the count it recorded — this
    // test only ever scaled it DOWN — and left it in the waking shape,
    // replicas restored with the ownership marker still on. That shape is what
    // lets the next caller resume the wake instead of finding an unmarked
    // zero-replica workload nobody may touch.
    const wedged = await readDeployment();
    expect(
      wedged.spec?.replicas,
      "the wake must have scaled the sleeping deployment back up",
    ).toBe(baselineReplicas);
    expect(
      wedged.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
      "a wake that cannot finish must keep the hibernation marker",
    ).toBe("true");
    expect(
      wedged.metadata?.annotations?.[MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION],
      "a wake that cannot finish must keep the replica count it has to restore",
    ).toBe(String(baselineReplicas));

    // And the pod that scale-up produced is stuck exactly where the wedge put
    // it: on the image that cannot be fetched, with nothing ever ready. This
    // is what makes the failure above attributable to the wedge rather than to
    // any other reason a wake could time out.
    const wedgedPods = await listDeploymentPods();
    expect(
      wedgedPods.length,
      "the wake must have scheduled a pod for the restored replicas",
    ).toBeGreaterThan(0);
    expect(
      wedgedPods.flatMap((pod) =>
        (pod.spec?.containers ?? []).map((container) => container.image),
      ),
    ).toContain(UNPULLABLE_WEDGE_IMAGE);
    const containerStatuses = wedgedPods.flatMap(
      (pod) => pod.status?.containerStatuses ?? [],
    );
    const waitingReasons = containerStatuses.map(
      (status) => status.state?.waiting?.reason ?? "",
    );
    expect(
      waitingReasons.some((reason) =>
        IMAGE_PULL_FAILURE_REASONS.includes(reason),
      ),
      `the pod must be stuck on the image it cannot pull; observed waiting reasons: ${waitingReasons.join(", ") || "none"}`,
    ).toBe(true);
    expect(
      containerStatuses.some((status) => status.ready),
      "no pod may be serving while the image cannot be pulled",
    ).toBe(false);
  });

  test("hard reset recreates the wedged deployment and the server serves again", async ({
    request,
    makeApiRequest,
  }) => {
    // Guard the oracles before using them: an empty baseline would make the
    // "serves again" comparison at the end vacuous, and an unrecorded uid
    // would make the identity comparison below hold against anything.
    requireRecordedBaseline();

    // The identity the recreate has to leave behind. Read fresh rather than
    // taken from the baseline test: patching a Deployment never changes its
    // uid, so this both records what to compare against AND proves the wedge
    // above was applied to the very object the baseline measured.
    const uidBeforeReset = await readDeploymentUid();
    expect(uidBeforeReset).toBe(baselineDeploymentUid);
    const wedgedPodNames = (await listDeploymentPods()).map(
      (pod) => pod.metadata?.name ?? "",
    );
    expect(
      wedgedPodNames.length,
      "fixture precondition: the wedged deployment still has the pod it could not start",
    ).toBeGreaterThan(0);

    const resetResponse = await hardReset(request);
    expect(
      resetResponse.status(),
      `hard reset failed: ${await resetResponse.text()}`,
    ).toBe(200);

    // What the platform reports it did — the only account an administrator
    // gets of a destructive action, and it has to describe THIS deployment.
    // The verdict itself is then read from the install row, the channel it
    // reaches whichever response shape the reply budget allowed.
    const result = await resetResponse.json();
    expectHardResetReport(result);
    await awaitHardResetRecovered(request);

    // The Deployment object is genuinely destroyed and rebuilt — patching in
    // place would carry the wedged pod template forward. Polled rather than
    // read once so that a reset which returns slightly ahead of the recreate
    // is not read as a missing recreate; an implementation that never recreates
    // exhausts the budget here.
    await expect
      .poll(
        async () => {
          const uid = await readDeploymentUid();
          return uid !== "absent" && uid !== uidBeforeReset;
        },
        { timeout: 120_000, intervals: CLUSTER_POLL_INTERVALS },
      )
      .toBe(true);

    const recreated = await readDeployment();
    expect(
      recreated.metadata?.uid,
      "hard reset must recreate the Deployment, not patch the wedged one",
    ).not.toBe(uidBeforeReset);

    // Rebuilt from stored configuration: the injected image is gone and the
    // install's own container is back. Asserting the container exists as well
    // as what it is NOT keeps an empty (or renamed) container list from
    // satisfying this by accident.
    const containers = recreated.spec?.template.spec?.containers ?? [];
    expect(
      containers.find((container) => container.name === MCP_CONTAINER_NAME)
        ?.image,
      "the rebuilt pod template must carry the install's real image",
    ).toBeTruthy();
    expect(containers.map((container) => container.image)).not.toContain(
      UNPULLABLE_WEDGE_IMAGE,
    );

    // Neither annotation survives. A reset that rebuilt the workload but left
    // the marker on would report a dormant server that is in fact serving, and
    // would hand the next sweep a deployment it believes it already owns.
    expect(
      recreated.metadata?.annotations?.[MCP_HIBERNATED_ANNOTATION],
    ).toBeUndefined();
    expect(
      recreated.metadata?.annotations?.[
        MCP_PRE_HIBERNATION_REPLICAS_ANNOTATION
      ],
    ).toBeUndefined();
    expect(recreated.spec?.replicas).toBe(baselineReplicas);

    // The product promise: the server answers again, with its real
    // configuration. The env value proves the recreated pod is the configured
    // one and not an empty shell that merely reports Ready.
    await callUntilServing(request);

    // Answered by a genuinely new pod — none of the wedged ones survived the
    // teardown — and by one that is really ready, not merely present.
    const servingPods = await listDeploymentPods();
    expect(
      servingPods
        .map((pod) => pod.metadata?.name ?? "")
        .filter((name) => wedgedPodNames.includes(name)),
      "no pod from the wedged deployment may have survived the teardown",
    ).toEqual([]);
    expect(
      servingPods.some((pod) =>
        (pod.status?.containerStatuses ?? []).some((status) => status.ready),
      ),
      "a ready pod must be serving the recreated deployment",
    ).toBe(true);

    // The install row is usable again too — a recovery that left the row
    // flagged would keep the registry blocking on it.
    const serverResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    const server = await serverResponse.json();
    expect(server.localInstallationStatus).toBe("success");
    expect(server.deploymentName).toBe(deploymentName);
  });

  test("hard reset preserves the configuration it does not own", async ({
    request,
    makeApiRequest,
  }) => {
    // `disabled` is what an operator reaches for after being burned by
    // hibernation: it pins this install permanently awake. A recovery action
    // that silently reverted it would put the server straight back to sleep on
    // the next sweep — which, with the organization toggle on, is minutes away.
    const beforeResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    expect(
      (await beforeResponse.json()).hibernationMode,
      "fixture precondition: the override set in beforeAll must still be stored",
    ).toBe("disabled");

    const resetResponse = await hardReset(request);
    expect(
      resetResponse.status(),
      `hard reset failed: ${await resetResponse.text()}`,
    ).toBe(200);
    // Settle before reading: a reset that outlived its reply budget is still
    // rewriting the row, and leaking it into the next test would poison that
    // test's own status reads.
    await awaitHardResetRecovered(request);

    const afterResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    const server = await afterResponse.json();
    expect(
      server.hibernationMode,
      "hard reset clears runtime state, never user configuration",
    ).toBe("disabled");
    // The per-install env value is user configuration too, and it is what the
    // rebuilt pod is actually launched with.
    expect(server.environmentValues?.ARCHESTRA_TEST).toBe(TEST_ENV_VALUE);
    // Deliberately NOT handed back to "inherit": the organization sweeper is
    // on in this cluster, and the tests below arrange cluster states by hand
    // that a sweep landing mid-test would invalidate.
  });

  test("hard reset is admin-only, and refuses what it cannot reset", async ({
    request,
    memberRequest,
    editorRequest,
    makeApiRequest,
    createMcpCatalogItem,
    installMcpServer,
    getTeamByName,
  }) => {
    // Destroying and recreating a Deployment affects every install sharing it,
    // so the route is gated on the org-wide mcpServerInstallation:admin
    // capability — which neither predefined non-admin role carries.
    for (const [role, roleRequest] of [
      ["member", memberRequest],
      ["editor", editorRequest],
    ] as const) {
      const response = await hardReset(roleRequest);
      expect(
        response.status(),
        `${role} must not be able to hard reset an MCP server`,
      ).toBe(403);
    }

    // The refusals have to be about the role and not about the request: the
    // same call as an admin succeeds.
    const adminResponse = await hardReset(request);
    expect(
      adminResponse.status(),
      `hard reset failed for admin: ${await adminResponse.text()}`,
    ).toBe(200);
    // Settled before the final "undisturbed" read below: past the reply
    // budget this reset is still running, and the row honestly says "pending"
    // until it lands.
    await awaitHardResetRecovered(request);

    // A remote server has no deployment to tear down. Rejecting it as a bad
    // request keeps it distinguishable from the unknown id below — answering
    // 404 for both would leave an operator unable to tell "wrong id" from
    // "wrong kind of server".
    const defaultTeam = await getTeamByName(request, DEFAULT_TEAM_NAME);
    const remoteCatalogResponse = await createMcpCatalogItem(request, {
      name: `e2e-hibernation-recovery-remote-${Date.now()}`,
      description: "Remote fixture: nothing for a hard reset to act on.",
      serverType: "remote",
      serverUrl: `${WIREMOCK_INTERNAL_URL}/mcp/context7`,
    });
    const remoteCatalog = await remoteCatalogResponse.json();
    remoteCatalogId = remoteCatalog.id;
    const remoteInstallResponse = await installMcpServer(request, {
      name: remoteCatalog.name,
      catalogId: remoteCatalog.id,
      scope: "team",
      teamId: defaultTeam.id,
    });
    const remoteId: string = (await remoteInstallResponse.json()).id;
    remoteServerId = remoteId;
    // Guard the default parameter: an id that came back empty would silently
    // retarget the assertions below at the live server.
    expect(remoteId).toBeTruthy();

    const remoteResponse = await hardReset(request, remoteId);
    expect([400, 409]).toContain(remoteResponse.status());

    const unknownResponse = await hardReset(request, crypto.randomUUID());
    expect(unknownResponse.status()).toBe(404);

    // None of the refused calls may have disturbed the live server.
    const serverResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server/${serverId}`,
    });
    expect((await serverResponse.json()).localInstallationStatus).toBe(
      "success",
    );
  });

  test("two concurrent hard resets perform exactly one teardown", async ({
    request,
    adminRequest,
  }) => {
    // An implementation that does NOT join the second caller runs two full
    // teardown/recreate cycles back to back, each of which waits for a real
    // pod to become ready — the failure this test exists to catch has to have
    // room to happen and be counted, not to be reported as a timeout.
    test.setTimeout(480_000);
    requireRecordedBaseline();

    const uidBefore = await readDeploymentUid();
    expect(uidBefore).not.toBe("absent");

    // Everything the cluster had already recorded about pods being created for
    // this deployment. The window's own recreations are the set difference
    // against this — evidence the cluster keeps, so nothing depends on a test
    // sampling the right instant, and nothing depends on the two cycles being
    // slow enough to be seen apart.
    const podCreationsBefore = await podCreationEventUids();

    // Two distinct admin request contexts, so the calls really are in flight
    // at the same time rather than pipelined onto one connection.
    const responses = await Promise.all([
      hardReset(request),
      hardReset(adminRequest),
    ]);

    // Both callers get a coherent answer: joining an in-flight reset is a
    // success, not a conflict the second caller is left to interpret.
    for (const [index, response] of responses.entries()) {
      expect(
        response.status(),
        `concurrent hard reset #${index + 1} failed: ${await response.text()}`,
      ).toBe(200);
    }
    const [firstResult, secondResult] = await Promise.all(
      responses.map((response) => response.json()),
    );

    // Both answers describe THIS deployment, whatever shape the reply budget
    // allowed each of them.
    expectHardResetReport(firstResult);
    expectHardResetReport(secondResult);
    // When both callers were answered inside the reply budget, they carry the
    // SAME completed report — teardown discriminant and all — which is the
    // most direct evidence the second joined the first: two independent
    // cycles would have to agree on "terminated" vs "force-killed" vs
    // "unverified", which the second, tearing down a deployment the first had
    // just rebuilt, has no reason to. Past the budget the acknowledgements
    // are structurally identical either way (the fixture's SIGTERM-ignoring
    // pod makes that the expected path), so the join is proven by the
    // cluster's own pod-creation ledger below.
    if (
      firstResult.status === "completed" &&
      secondResult.status === "completed"
    ) {
      expect(
        secondResult,
        "the second caller must be answered with the reset it joined",
      ).toEqual(firstResult);
    }
    await awaitHardResetRecovered(request);

    // The recreation is really in the cluster, not just claimed: a reset can
    // return marginally ahead of the object appearing.
    await expect
      .poll(
        async () => {
          const uid = await readDeploymentUid();
          return uid !== "absent" && uid !== uidBefore;
        },
        { timeout: 120_000, intervals: CLUSTER_POLL_INTERVALS },
      )
      .toBe(true);

    // And it still serves — a reset storm must not end in a broken server.
    await callUntilServing(request);

    // Exactly one teardown, counted from what the cluster recorded. Every
    // recreate builds a new ReplicaSet which creates exactly one pod, and
    // Kubernetes writes one event per pod created. Both POSTs have returned
    // and the server is answering by now, so nothing can still be added to
    // this window: a second, unjoined teardown/recreate leaves two.
    expect(
      await newPodCreationsSince(podCreationsBefore),
      "a concurrent hard reset must join the in-flight one, not run a second teardown",
    ).toBe(1);

    // No orphans: the recreation reuses the frozen deployment name, and no
    // Service was left behind carrying this install's id.
    expect(await listOwnedDeploymentNames()).toEqual([deploymentName]);
    expect(await listOwnedServiceNames()).toEqual(baselineServiceNames);
  });

  test("no illegal lifecycle transition was refused for this deployment", async () => {
    // The state machine refuses (and logs) any lifecycle move its transition
    // table forbids rather than throwing, so a recovery path that reasons from
    // a state it should not be in fails silently and leaves only this warning
    // behind. Everything above drove this deployment through hibernated ->
    // waking -> failed wake -> repeated teardown and recreate; none of it may
    // have had to punch through the machine.
    const logs = await readPlatformLogs();
    test.skip(
      logs === null,
      "platform logs are not observable from a test here: no readable pod matches " +
        PLATFORM_POD_LABEL_SELECTOR,
    );

    // deploymentName appears in every refusal record and is unique to this
    // spec's install, so specs running in parallel cannot poison the result.
    const attributable = (logs ?? "")
      .split("\n")
      .filter((line) => line.includes(deploymentName));

    // Positive control. The filter above is the whole assertion, so a window
    // that never names this deployment at all cannot tell "nothing was
    // refused" from "nothing was read" — a truncated window, a log level that
    // hides these records, or a name this build no longer logs would all read
    // as health. Every hard reset above logs the physical deployment it acted
    // on, so at least one record must carry it.
    expect(
      attributable.length,
      `no platform log record in this window names ${deploymentName}, so the window is not evidence about it`,
    ).toBeGreaterThan(0);

    const offending = attributable.filter((line) =>
      line.includes(ILLEGAL_TRANSITION_LOG_MESSAGE),
    );

    expect(
      offending,
      `the platform refused an illegal hibernation transition for ${deploymentName}`,
    ).toEqual([]);
  });

  /**
   * The platform's own log stream for the window this spec has been running,
   * or `null` when it cannot be observed from here (the platform does not run
   * as a labelled pod in this cluster, or its log endpoint refused). `null` is
   * deliberately distinct from `""`, so an unreadable stream can never be
   * mistaken for evidence that no warning was produced.
   */
  async function readPlatformLogs(): Promise<string | null> {
    const pods = await coreApi
      .listPodForAllNamespaces({ labelSelector: PLATFORM_POD_LABEL_SELECTOR })
      .catch(() => null);
    if (!pods || pods.items.length === 0) return null;

    const sinceSeconds = Math.ceil((Date.now() - specStartedAtMs) / 1_000) + 60;
    const chunks: string[] = [];
    for (const pod of pods.items) {
      const name = pod.metadata?.name;
      const namespace = pod.metadata?.namespace;
      if (!name || !namespace) continue;
      const log = await coreApi
        .readNamespacedPodLog({
          name,
          namespace,
          container: PLATFORM_CONTAINER_NAME,
          sinceSeconds,
        })
        // A multi-container pod rejects a read with no container named; a pod
        // whose container is named otherwise rejects this one. Try both before
        // concluding the stream is unreadable.
        .catch(() =>
          coreApi
            .readNamespacedPodLog({ name, namespace, sinceSeconds })
            .catch(() => null),
        );
      if (log != null) chunks.push(log);
    }

    if (chunks.length === 0) return null;
    const combined = chunks.join("\n");
    // An empty window means the read landed somewhere that logs nothing —
    // unobservable, not evidence of absence.
    return combined.trim().length === 0 ? null : combined;
  }
});
