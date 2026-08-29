import type * as k8s from "@kubernetes/client-node";
import type { RunnerLaunchSpec } from "@/services/runners/backends";
import {
  RUNNER_ATTACH_SCRIPT,
  RUNNER_ATTACHMENTS_DIR,
  RUNNER_ATTACHMENTS_MANIFEST,
  RUNNER_INPUTS_READY_FILE,
  RUNNER_RUNTIME_DIR,
  RUNNER_SHELL_INIT_SCRIPT,
  RUNNER_STEER_FIFO,
} from "@/services/runners/runtime-contract";
import type { AgentDeploymentResources } from "@/types";
import { RUNNER_TASK_LABEL, runnerLabels, runnerNames } from "./naming";

const DNS_PORTS = [
  { protocol: "UDP" as const, port: 53 },
  { protocol: "TCP" as const, port: 53 },
];

/** Session `tmux attach` lands in — the pane the agent itself is using. */
export const RUNNER_TMUX_SESSION = "agent";

/** Container name in the Job spec; exec and log reads both address it. */
export const RUNNER_CONTAINER_NAME = "runner";

/**
 * Install the stable attach command and the hook used by kubectl/k9s shells.
 * Kept as a script so the manager can repair live pods created before an
 * upgrade without relying on anything beyond the image's required /bin/sh.
 */
export function buildRunnerTerminalIntegrationScript(): string {
  return [
    `printf '%s\\n' '#!/bin/sh' 'tmux set-option -t ${RUNNER_TMUX_SESSION} mouse on' 'exec tmux attach -t ${RUNNER_TMUX_SESSION}' > ${RUNNER_ATTACH_SCRIPT}`,
    `chmod 755 ${RUNNER_ATTACH_SCRIPT}`,
    `printf '%s\\n' 'if [ "\${ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AUTO_ATTACH:-1}" = "1" ] && [ -t 0 ] && [ -t 1 ] && [ -z "\${TMUX:-}" ] && tmux has-session -t ${RUNNER_TMUX_SESSION} 2>/dev/null; then exec ${RUNNER_ATTACH_SCRIPT}; fi' > ${RUNNER_SHELL_INIT_SCRIPT}`,
    `chmod 644 ${RUNNER_SHELL_INIT_SCRIPT}`,
  ].join("\n");
}

/**
 * Exit code the bootstrap uses when the image cannot host a runner. Distinct
 * from any exit code the agent itself produces, so "your image is missing
 * tmux" never reads as "your agent failed".
 */
const RUNNER_UNUSABLE_IMAGE_EXIT_CODE = 78;

/**
 * Everything the runtime needs to launch one runner, already resolved: no
 * credential lookups, no config reads, no database access happen below this
 * boundary. That keeps manifest construction a pure function of its input and
 * testable without a cluster.
 */
export type KubernetesRunnerLaunchSpec = Omit<
  RunnerLaunchSpec,
  "runtimeScope"
> & {
  namespace: string;
  /** Kubernetes garbage-collection owner, resolved inside this backend. */
  ownerReferences: k8s.V1OwnerReference[] | undefined;
};

/**
 * PID 1 for every runner, whatever the image.
 *
 * tmux is what makes a session attachable and steerable: a human can attach
 * from the browser and type into the same session the agent is using, and a
 * steer can be delivered without a terminal attached at all. The FIFO is the
 * turn-boundary channel the Archestra runner-agent reads; bring-your-own-image
 * CLIs that own their own input loop are steered with `tmux send-keys`
 * instead, which needs no cooperation from the process.
 *
 * The wrapper deliberately does not restart the agent: the Job's
 * `restartPolicy: Never` plus `backoffLimit: 0` means a session that exits
 * stays exited rather than silently re-running whatever side effects it had
 * already performed.
 */
function buildRunnerBootstrapScript(): string {
  const exitCodeFile = `${RUNNER_RUNTIME_DIR}/exit-code`;
  return [
    "set -eu",
    `mkdir -p ${RUNNER_RUNTIME_DIR}`,
    buildRunnerTerminalIntegrationScript(),
    `mkdir -p ${RUNNER_ATTACHMENTS_DIR}`,
    'if [ "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_INPUT_FILE_COUNT" -gt 0 ]; then',
    `  echo "[runner] staging $ARCHESTRA_AGENT_BACKGROUND_EXECUTION_INPUT_FILE_COUNT input file(s)"`,
    `  attempts=0; while [ ! -f ${RUNNER_INPUTS_READY_FILE} ]; do`,
    "    attempts=$((attempts + 1))",
    '    if [ "$attempts" -gt 300 ]; then echo "runner: timed out while staging execution inputs" >&2; exit 74; fi',
    "    sleep 1",
    "  done",
    "fi",
    `[ -p "${RUNNER_STEER_FIFO}" ] || mkfifo -m 600 "${RUNNER_STEER_FIFO}"`,
    "if ! command -v tmux >/dev/null 2>&1; then",
    '  echo "runner: this image has no tmux, which runners require for attach and steering" >&2',
    `  exit ${RUNNER_UNUSABLE_IMAGE_EXIT_CODE}`,
    "fi",
    `printf '%s\\n' "$ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ENTRYPOINT" > ${RUNNER_RUNTIME_DIR}/entry.sh`,
    `printf '%s\n' '/bin/sh ${RUNNER_RUNTIME_DIR}/entry.sh; status=$?; printf "%s\\n" "$status" > ${exitCodeFile}; echo; echo "[runner] agent session exited"; exit "$status"' > ${RUNNER_RUNTIME_DIR}/session.sh`,
    // Create the pane before starting the Agent so its output cannot race the
    // pipe setup. A fast one-shot client used to finish before pipe-pane was
    // attached, leaving its durable transcript empty.
    `tmux new-session -d -s ${RUNNER_TMUX_SESSION} 'while :; do sleep 1; done'`,
    // Let browser terminals send wheel events to tmux. Its WheelUpPane binding
    // enters copy mode and scrolls tmux's own history; without mouse mode,
    // xterm falls back to cursor-key sequences that get typed into the pane.
    `tmux set-option -t ${RUNNER_TMUX_SESSION} mouse on`,
    // Mirror the pane to the container's stdout. tmux gives the agent a pty,
    // so without this its output exists only inside the pane: kubectl logs
    // shows nothing, and the platform's log-follower streams an empty task.
    `tmux pipe-pane -t ${RUNNER_TMUX_SESSION} -o 'cat >> /proc/1/fd/1'`,
    `tmux respawn-pane -k -t ${RUNNER_TMUX_SESSION} '/bin/sh ${RUNNER_RUNTIME_DIR}/session.sh'`,
    // Hold PID 1 for exactly as long as the session lives, so the Job
    // completes when the agent is done rather than when tmux forks away.
    `while tmux has-session -t ${RUNNER_TMUX_SESSION} 2>/dev/null; do sleep 5; done`,
    `if [ ! -f ${exitCodeFile} ]; then`,
    '  echo "runner: agent session ended without an exit status" >&2',
    "  exit 1",
    "fi",
    `exit "$(cat ${exitCodeFile})"`,
  ].join("\n");
}

/**
 * A Job, not a Deployment: a runner runs to completion. A Deployment would
 * restart a finished session forever, and restart a crashed one behind the
 * user's back — re-executing side effects the first attempt already had.
 */
export function buildRunnerJob(spec: KubernetesRunnerLaunchSpec): k8s.V1Job {
  const names = runnerNames(spec.frozenName);
  const labels = runnerLabels({ taskId: spec.taskId, runnerId: spec.runnerId });

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: names.job,
      namespace: spec.namespace,
      labels,
      ownerReferences: spec.ownerReferences,
    },
    spec: {
      // One attempt, one pod: see buildRunnerBootstrapScript.
      backoffLimit: 0,
      parallelism: 1,
      completions: 1,
      ...(spec.activeDeadlineSeconds
        ? { activeDeadlineSeconds: spec.activeDeadlineSeconds }
        : {}),
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          ...(spec.imagePullSecrets.length > 0
            ? {
                imagePullSecrets: spec.imagePullSecrets.map((name) => ({
                  name,
                })),
              }
            : {}),
          // The agent authenticates to the platform with credentials mounted
          // from a Secret; it has no business reading the cluster's API.
          automountServiceAccountToken: false,
          volumes: [
            {
              name: "archestra-run",
              emptyDir: { sizeLimit: spec.ephemeralStorageLimit },
            },
          ],
          containers: [
            {
              name: RUNNER_CONTAINER_NAME,
              image: spec.image,
              command: ["/bin/sh", "-c", buildRunnerBootstrapScript()],
              env: [
                ...Object.entries({
                  // tmux decides whether a client supports Unicode from its
                  // locale. Kubernetes does not provide one by default, which
                  // made Claude Code replace bullets, emoji, and line art with
                  // underscores in both kubectl and the browser terminal.
                  LANG: "C.UTF-8",
                  LC_ALL: "C.UTF-8",
                  TERM: "xterm-256color",
                  // k9s opens `bash` or `sh` directly. These standard shell
                  // hooks join the already-running tmux pane on first prompt.
                  ENV: RUNNER_SHELL_INIT_SCRIPT,
                  PROMPT_COMMAND: `. ${RUNNER_SHELL_INIT_SCRIPT}`,
                  ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AUTO_ATTACH: "1",
                  ...spec.env,
                }).map(([name, value]) => ({ name, value })),
                {
                  name: "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ENTRYPOINT",
                  value: resolveEntrypoint(spec.command),
                },
                {
                  name: "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_INPUT_FILE_COUNT",
                  value: String(spec.inputFileCount),
                },
                {
                  name: "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ATTACHMENTS_DIR",
                  value: RUNNER_ATTACHMENTS_DIR,
                },
                {
                  name: "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ATTACHMENTS_MANIFEST",
                  value: RUNNER_ATTACHMENTS_MANIFEST,
                },
              ],
              ...(Object.keys(spec.secretEnv).length > 0
                ? {
                    envFrom: [{ secretRef: { name: names.secret } }],
                  }
                : {}),
              resources: buildResourceRequirements(spec.resources),
              volumeMounts: [
                { name: "archestra-run", mountPath: RUNNER_RUNTIME_DIR },
              ],
              ...(spec.privileged
                ? { securityContext: { privileged: true } }
                : { securityContext: { allowPrivilegeEscalation: false } }),
            },
          ],
        },
      },
    },
  };
}

export function buildRunnerSecret(
  spec: KubernetesRunnerLaunchSpec,
): k8s.V1Secret {
  const names = runnerNames(spec.frozenName);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: names.secret,
      namespace: spec.namespace,
      labels: runnerLabels({ taskId: spec.taskId, runnerId: spec.runnerId }),
      ownerReferences: spec.ownerReferences,
    },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(spec.secretEnv).map(([key, value]) => [
        key,
        Buffer.from(value, "utf8").toString("base64"),
      ]),
    ),
  };
}

/**
 * Egress to the platform's own API, as a second policy selecting only runner
 * pods rather than an edit to the shared MCP builders.
 *
 * Kubernetes unions the egress rules of every policy selecting a pod, so this
 * composes with whatever policy the runner's environment already applies
 * without widening anything for MCP servers. A runner that cannot reach the
 * LLM proxy and MCP gateway is useless, and a runner that reaches the wider
 * network is the environment's decision to make, not this policy's.
 */
export function buildRunnerPlatformEgressPolicy(params: {
  spec: KubernetesRunnerLaunchSpec;
  platformNamespace: string;
  platformPodLabels: Record<string, string>;
  platformPorts: number[];
}): k8s.V1NetworkPolicy {
  const names = runnerNames(params.spec.frozenName);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: names.networkPolicy,
      namespace: params.spec.namespace,
      labels: runnerLabels({
        taskId: params.spec.taskId,
        runnerId: params.spec.runnerId,
      }),
      ownerReferences: params.spec.ownerReferences,
    },
    spec: {
      podSelector: {
        matchLabels: { [RUNNER_TASK_LABEL]: params.spec.taskId },
      },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  "kubernetes.io/metadata.name": params.platformNamespace,
                },
              },
              podSelector: { matchLabels: params.platformPodLabels },
            },
          ],
          ports: params.platformPorts.map((port) => ({
            protocol: "TCP",
            port,
          })),
        },
        // DNS. Once any egress policy selects a pod, its egress is clamped to
        // the union of the selecting policies — and runner pods carry labels no
        // other policy selects, so without this rule the session cannot resolve
        // the platform's own hostname and fails at its first call.
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
              },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: DNS_PORTS,
        },
        // Clusters whose resolver is not the labelled kube-dns pod (a node-local
        // cache, or a managed control plane) need the port opened by CIDR too.
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
          ports: DNS_PORTS,
        },
      ],
    },
  };
}

/**
 * Apply the Agent Environment's effective egress policy to this execution.
 *
 * This deliberately reuses the MCP runtime's policy builders: an Agent and an
 * MCP server assigned to the same Environment must interpret unrestricted,
 * restricted, and disabled egress identically. The platform policy above is a
 * second policy; Kubernetes unions both rule sets so a restricted execution
 * can always reach Archestra without gaining arbitrary public access.
 */
// ===================== internals =====================

/**
 * With no command configured the image must provide `archestra-runner-agent`
 * on PATH — the contract the default image satisfies and every
 * bring-your-own-image either satisfies or overrides with its own command.
 */
function resolveEntrypoint(command: string[] | null): string {
  const resolved =
    !command || command.length === 0
      ? "archestra-runner-agent"
      : command.map(shellQuote).join(" ");
  return [
    "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi",
    `exec ${resolved}`,
  ].join("\n");
}

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function buildResourceRequirements(
  resources: AgentDeploymentResources | null,
): k8s.V1ResourceRequirements {
  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};
  if (resources?.cpuRequest) requests.cpu = resources.cpuRequest;
  if (resources?.memoryRequest) requests.memory = resources.memoryRequest;
  if (resources?.cpuLimit) limits.cpu = resources.cpuLimit;
  if (resources?.memoryLimit) limits.memory = resources.memoryLimit;
  return {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}
