import { isIP } from "node:net";
import type * as k8s from "@kubernetes/client-node";
import type { AgentRunLaunchSpec } from "@/services/agent-runtime/backends";
import { buildImageRuntimeInstallScript } from "@/services/agent-runtime/image-runtime/bootstrap";
import { AGENT_IMAGE_RUNTIME } from "@/services/agent-runtime/image-runtime/contract";
import {
  AGENT_RUNTIME_ATTACH_SCRIPT,
  AGENT_RUNTIME_ATTACHMENTS_DIR,
  AGENT_RUNTIME_ATTACHMENTS_MANIFEST,
  AGENT_RUNTIME_CREDENTIALS_DIR,
  AGENT_RUNTIME_CREDENTIALS_FILE,
  AGENT_RUNTIME_CREDENTIALS_SECRET_KEY,
  AGENT_RUNTIME_DIR,
  AGENT_RUNTIME_INPUTS_READY_FILE,
  AGENT_RUNTIME_SHELL_INIT_SCRIPT,
  AGENT_RUNTIME_STEER_FIFO,
} from "@/services/agent-runtime/runtime-contract";
import type { AgentRuntimeResources } from "@/types";
import {
  AGENT_RUNTIME_TASK_LABEL,
  AGENT_RUNTIME_WORKSPACE_LABEL,
  agentRuntimeLabels,
  agentRuntimeNames,
} from "./naming";
import { buildSandboxSupervisorScript } from "./sandbox-supervisor";

const DNS_PORTS = [
  { protocol: "UDP" as const, port: 53 },
  { protocol: "TCP" as const, port: 53 },
];

/** Container name in the Job spec; exec and log reads both address it. */
export const AGENT_RUNTIME_CONTAINER_NAME = "agent-runtime";

/** Pinned upstream API; the controller is installed by the cluster operator. */
export const AGENT_SANDBOX_API = {
  group: "agents.x-k8s.io",
  version: "v1beta1",
  plural: "sandboxes",
} as const;

export interface AgentSandbox {
  apiVersion: "agents.x-k8s.io/v1beta1";
  kind: "Sandbox";
  metadata: k8s.V1ObjectMeta;
  spec: {
    podTemplate: k8s.V1PodTemplateSpec;
    operatingMode: "Running" | "Suspended";
    service: boolean;
    shutdownTime?: string;
    shutdownPolicy: "Retain";
    volumeClaimTemplates: Array<{
      metadata: k8s.V1ObjectMeta;
      spec: k8s.V1PersistentVolumeClaimSpec;
    }>;
  };
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }>;
  };
}

/** Render a turn request without interpolating credentials into exec arguments. */
export function buildAgentRuntimeTurnScript(
  spec: AgentRunLaunchSpec,
  options: { inheritedVariableNames?: string[]; initial?: boolean } = {},
): string {
  const { inheritedVariableNames = [], initial = false } = options;
  const variables = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm-256color",
    ENV: AGENT_RUNTIME_SHELL_INIT_SCRIPT,
    PROMPT_COMMAND: `. ${AGENT_RUNTIME_SHELL_INIT_SCRIPT}`,
    ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH: "1",
    ARCHESTRA_AGENT_RUNTIME_INPUT_FILE_COUNT: "0",
    ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR: AGENT_RUNTIME_ATTACHMENTS_DIR,
    ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST:
      AGENT_RUNTIME_ATTACHMENTS_MANIFEST,
    ...spec.env,
    ...spec.secretEnv,
    ARCHESTRA_AGENT_RUNTIME_CONTINUE: initial ? "0" : "1",
    ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE: AGENT_RUNTIME_CREDENTIALS_FILE,
  };
  return [
    "set -eu",
    // A retained terminal inherits the initial Pod environment. Remove its
    // managed variables before applying this turn, including removed credentials.
    ...inheritedVariableNames.map((name) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error("Invalid runtime environment variable name");
      return `unset ${name}`;
    }),
    ...Object.entries(variables).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error("Invalid runtime environment variable name");
      return `export ${name}=${shellQuote(value)}`;
    }),
    ...(spec.renewableCredentials
      ? [waitForCredentialProjection(spec.taskId)]
      : []),
    resolveEntrypoint(spec.command),
  ].join("\n");
}

/**
 * Install the stable attach command and the hook used by kubectl/k9s shells.
 * Kept as a script so the manager can repair live pods created before an
 * upgrade without relying on anything beyond the image's required /bin/sh.
 */
export function buildAgentRuntimeTerminalIntegrationScript(): string {
  return [
    "set -e",
    buildImageRuntimeInstallScript(),
    `printf '%s\\n' '#!/bin/sh' 'exec ${AGENT_IMAGE_RUNTIME} attach' > ${AGENT_RUNTIME_ATTACH_SCRIPT}`,
    `chmod 755 ${AGENT_RUNTIME_ATTACH_SCRIPT}`,
    `printf '%s\\n' 'if [ -t 0 ] && [ -t 1 ]; then date +%s > /var/run/archestra/development-activity; fi' 'if [ "\${ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH:-1}" = "1" ] && [ -t 0 ] && [ -t 1 ] && ! ${AGENT_IMAGE_RUNTIME} inside && ${AGENT_IMAGE_RUNTIME} ready 2>/dev/null; then exec ${AGENT_RUNTIME_ATTACH_SCRIPT}; fi' > ${AGENT_RUNTIME_SHELL_INIT_SCRIPT}`,
    `chmod 644 ${AGENT_RUNTIME_SHELL_INIT_SCRIPT}`,
  ].join("\n");
}

/**
 * Everything the runtime needs to launch one Agent Runtime run, already resolved: no
 * credential lookups, no config reads, no database access happen below this
 * boundary. That keeps manifest construction a pure function of its input and
 * testable without a cluster.
 */
export type KubernetesAgentRunLaunchSpec = Omit<
  AgentRunLaunchSpec,
  "runtimeScope"
> & {
  namespace: string;
  /** Kubernetes garbage-collection owner, resolved inside this backend. */
  ownerReferences: k8s.V1OwnerReference[] | undefined;
};

/**
 * PID 1 for every Agent Runtime run, whatever the image.
 *
 * The image runtime owns terminal creation, attachment and literal input. The
 * FIFO remains the turn-boundary channel for cooperating harnesses.
 *
 * The workspace supervisor owns PID 1; agent command completion is independent
 * of Pod completion. Durable request markers prevent replay after replacement.
 */
function buildAgentRuntimeBootstrapScript(): string {
  return [
    "set -eu",
    `mkdir -p ${AGENT_RUNTIME_DIR}`,
    buildAgentRuntimeTerminalIntegrationScript(),
    `mkdir -p ${AGENT_RUNTIME_ATTACHMENTS_DIR}`,
    'if [ "$ARCHESTRA_AGENT_RUNTIME_INPUT_FILE_COUNT" -gt 0 ]; then',
    `  echo "[agent-runtime] staging $ARCHESTRA_AGENT_RUNTIME_INPUT_FILE_COUNT input file(s)"`,
    `  attempts=0; while [ ! -f ${AGENT_RUNTIME_INPUTS_READY_FILE} ]; do`,
    "    attempts=$((attempts + 1))",
    '    if [ "$attempts" -gt 300 ]; then echo "agent-runtime: timed out while staging run inputs" >&2; exit 74; fi',
    "    sleep 1",
    "  done",
    "fi",
    `[ -p "${AGENT_RUNTIME_STEER_FIFO}" ] || mkfifo -m 600 "${AGENT_RUNTIME_STEER_FIFO}"`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion.
    'if [ "${ARCHESTRA_AGENT_RUNTIME_WARM:-0}" != 1 ]; then',
    'case "$ARCHESTRA_AGENT_RUNTIME_TASK_ID" in ""|*[!a-zA-Z0-9-]*) echo "Invalid runtime task ID" >&2; exit 78;; esac',
    `mkdir -p ${AGENT_RUNTIME_DIR}/turns`,
    `request=${AGENT_RUNTIME_DIR}/turns/$ARCHESTRA_AGENT_RUNTIME_TASK_ID.request`,
    `if [ ! -f "$request" ] && [ ! -f "${AGENT_RUNTIME_DIR}/turns/$ARCHESTRA_AGENT_RUNTIME_TASK_ID.exit" ]; then`,
    "  umask 077",
    `  printf '%s\\n' "$ARCHESTRA_AGENT_RUNTIME_ENTRYPOINT" > "$request.tmp"`,
    '  mv "$request.tmp" "$request"',
    "fi",
    "fi",
    buildSandboxSupervisorScript(),
  ].join("\n");
}

/**
 * A durable Sandbox owns the workspace; the supervisor executes each request
 * at most once, independently of the controller's Pod replacement policy.
 */
export function buildAgentRuntimeSandbox(
  spec: KubernetesAgentRunLaunchSpec,
): AgentSandbox {
  const names = agentRuntimeNames(spec.frozenName);
  const labels = agentRuntimeLabels({
    taskId: spec.taskId,
    agentRuntimeId: spec.agentRuntimeId,
  });
  labels[AGENT_RUNTIME_WORKSPACE_LABEL] = spec.frozenName;

  return {
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata: {
      name: names.sandbox,
      namespace: spec.namespace,
      labels,
      ownerReferences: spec.ownerReferences,
    },
    spec: {
      operatingMode: "Running",
      // Controller-owned headless Service preserves the workspace DNS identity.
      service: true,
      shutdownPolicy: "Retain",
      volumeClaimTemplates: [
        {
          metadata: { name: "workspace" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: {
              requests: { storage: spec.workspaceStorageSize ?? "20Gi" },
            },
            ...(spec.workspaceStorageClass
              ? { storageClassName: spec.workspaceStorageClass }
              : {}),
          },
        },
      ],
      ...(spec.activeDeadlineSeconds
        ? {
            shutdownTime: new Date(
              Date.now() + spec.activeDeadlineSeconds * 1000,
            ).toISOString(),
          }
        : {}),
      podTemplate: {
        metadata: {
          labels,
        },
        spec: {
          restartPolicy: "Never",
          // A dedicated Agent Runtime pool keeps heavy privileged runs from
          // pressuring the platform's own nodes. The selector's pairs double
          // as tolerations so a pool tainted with the same key=value admits
          // exactly these pods.
          ...(Object.keys(spec.nodeSelector).length > 0
            ? {
                nodeSelector: spec.nodeSelector,
                tolerations: Object.entries(spec.nodeSelector).map(
                  ([key, value]) => ({
                    key,
                    operator: "Equal",
                    value,
                    effect: "NoSchedule",
                  }),
                ),
              }
            : {}),
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
          securityContext: { fsGroup: 1000 },
          // Seed image-provided HOME configuration once, before mounting the
          // durable HOME over it. A blank PVC must not hide bundled settings.
          initContainers: [
            {
              name: "initialize-workspace",
              image: spec.image,
              command: [
                "/bin/sh",
                "-c",
                [
                  "set -eu",
                  "mkdir -p /mnt/workspace/runtime /mnt/workspace/home /mnt/workspace/docker",
                  "if [ ! -f /mnt/workspace/.initialized ]; then",
                  "  if [ -d /home/node ]; then cp -R /home/node/. /mnt/workspace/home/; fi",
                  "  touch /mnt/workspace/.initialized",
                  "fi",
                ].join("\n"),
              ],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                allowPrivilegeEscalation: false,
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/mnt/workspace" },
              ],
            },
          ],
          containers: [
            {
              name: AGENT_RUNTIME_CONTAINER_NAME,
              image: spec.image,
              command: [
                "/bin/sh",
                "-c",
                // Kubelet expands command arguments before the shell sees them,
                // including reducing $$ to $. Preserve the embedded source bytes.
                buildAgentRuntimeBootstrapScript().replaceAll("$", () => "$$"),
              ],
              env: [
                ...Object.entries({
                  // The terminal determines Unicode support from its
                  // locale. Kubernetes does not provide one by default, which
                  // made Claude Code replace bullets, emoji, and line art with
                  // underscores in both kubectl and the browser terminal.
                  LANG: "C.UTF-8",
                  LC_ALL: "C.UTF-8",
                  TERM: "xterm-256color",
                  // k9s opens `bash` or `sh` directly. These standard shell
                  // hooks join the existing agent terminal on first prompt.
                  ENV: AGENT_RUNTIME_SHELL_INIT_SCRIPT,
                  PROMPT_COMMAND: `. ${AGENT_RUNTIME_SHELL_INIT_SCRIPT}`,
                  ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH: "1",
                  ...spec.env,
                  ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE:
                    AGENT_RUNTIME_CREDENTIALS_FILE,
                }).map(([name, value]) => ({ name, value })),
                {
                  name: "ARCHESTRA_AGENT_RUNTIME_ENTRYPOINT",
                  value: spec.renewableCredentials
                    ? `${waitForCredentialProjection(spec.taskId)}\n${resolveEntrypoint(spec.command)}`
                    : resolveEntrypoint(spec.command),
                },
                {
                  name: "ARCHESTRA_AGENT_RUNTIME_INPUT_FILE_COUNT",
                  value: String(spec.inputFileCount),
                },
                {
                  name: "ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR",
                  value: AGENT_RUNTIME_ATTACHMENTS_DIR,
                },
                {
                  name: "ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_MANIFEST",
                  value: AGENT_RUNTIME_ATTACHMENTS_MANIFEST,
                },
              ],
              ...(Object.keys(spec.secretEnv).length > 0
                ? {
                    envFrom: [{ secretRef: { name: names.secret } }],
                  }
                : {}),
              resources: buildResourceRequirements(spec.resources),
              volumeMounts: [
                {
                  name: "renewable-credentials",
                  mountPath: AGENT_RUNTIME_CREDENTIALS_DIR,
                  readOnly: true,
                },
                {
                  name: "workspace",
                  mountPath: AGENT_RUNTIME_DIR,
                  subPath: "runtime",
                },
                { name: "workspace", mountPath: "/home/node", subPath: "home" },
                ...(spec.privileged
                  ? // Keep nested development containers, images and volumes on
                    // the same durable disk as the workspace. A Pod replacement
                    // restarts dockerd; it must not erase the development DB.
                    [
                      {
                        name: "workspace",
                        mountPath: "/var/lib/docker",
                        subPath: "docker",
                      },
                    ]
                  : []),
              ],
              ...(spec.privileged
                ? { securityContext: { privileged: true } }
                : { securityContext: { allowPrivilegeEscalation: false } }),
            },
          ],
          volumes: [
            {
              name: "renewable-credentials",
              secret: {
                secretName: names.secret,
                defaultMode: 0o440,
                items: [
                  {
                    key: AGENT_RUNTIME_CREDENTIALS_SECRET_KEY,
                    path: "current.json",
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

export function buildAgentRuntimeSecret(
  spec: KubernetesAgentRunLaunchSpec,
): k8s.V1Secret {
  const names = agentRuntimeNames(spec.frozenName);
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: names.secret,
      namespace: spec.namespace,
      labels: agentRuntimeLabels({
        taskId: spec.taskId,
        agentRuntimeId: spec.agentRuntimeId,
      }),
      ownerReferences: spec.ownerReferences,
    },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries({
        ...spec.secretEnv,
        [AGENT_RUNTIME_CREDENTIALS_SECRET_KEY]: JSON.stringify({
          taskId: spec.taskId,
          credentials: spec.renewableCredentials ?? {},
        }),
      }).map(([key, value]) => [
        key,
        Buffer.from(value, "utf8").toString("base64"),
      ]),
    ),
  };
}

/**
 * Egress to the platform's own API, as a second policy selecting only Agent Runtime
 * pods rather than an edit to the shared MCP builders.
 *
 * Kubernetes unions the egress rules of every policy selecting a pod, so this
 * composes with whatever policy the Agent Runtime run's environment already applies
 * without widening anything for MCP servers. An Agent Runtime run that cannot reach the
 * LLM proxy and MCP gateway is useless, and an Agent Runtime run that reaches the wider
 * network is the environment's decision to make, not this policy's.
 */
export function buildAgentRuntimePlatformEgressPolicy(params: {
  spec: Pick<
    KubernetesAgentRunLaunchSpec,
    "frozenName" | "namespace" | "taskId" | "agentRuntimeId" | "ownerReferences"
  >;
  platformNamespace: string;
  platformPodLabels: Record<string, string>;
  platformPorts: number[];
  platformService?: { ips: string[]; port: number };
}): k8s.V1NetworkPolicy {
  const names = agentRuntimeNames(params.spec.frozenName);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: names.networkPolicy,
      namespace: params.spec.namespace,
      labels: agentRuntimeLabels({
        taskId: params.spec.taskId,
        agentRuntimeId: params.spec.agentRuntimeId,
      }),
      ownerReferences: params.spec.ownerReferences,
    },
    spec: {
      podSelector: {
        matchLabels: { [AGENT_RUNTIME_TASK_LABEL]: params.spec.taskId },
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
        // Some CNIs enforce egress before Service DNAT. Pod selectors cover
        // endpoint IPs, so the configured Service also needs an exact IP rule.
        ...(params.platformService?.ips.length
          ? [
              {
                to: params.platformService.ips.map((ip) => ({
                  ipBlock: { cidr: `${ip}/${isIP(ip) === 6 ? 128 : 32}` },
                })),
                ports: [{ protocol: "TCP", port: params.platformService.port }],
              },
            ]
          : []),
        // DNS. Once any egress policy selects a pod, its egress is clamped to
        // the union of the selecting policies — and Agent Runtime pods carry labels no
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
 * Apply the Agent Environment's effective egress policy to this run.
 *
 * This deliberately reuses the MCP runtime's policy builders: an Agent and an
 * MCP server assigned to the same Environment must interpret unrestricted,
 * restricted, and disabled egress identically. The platform policy above is a
 * second policy; Kubernetes unions both rule sets so a restricted run
 * can always reach Archestra without gaining arbitrary public access.
 */
// ===================== internals =====================

/**
 * With no command configured the image must provide `archestra-runtime-agent`
 * on PATH — the contract the default image satisfies and every
 * bring-your-own-image either satisfies or overrides with its own command.
 */
function resolveEntrypoint(command: string[] | null): string {
  const resolved =
    !command || command.length === 0
      ? "archestra-runtime-agent"
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
  resources: AgentRuntimeResources | null,
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

/** A continuation must not launch against the previous turn's projected Secret. */
function waitForCredentialProjection(taskId: string): string {
  return [
    "credential_polls=0",
    `until grep -qF ${shellQuote(`{"taskId":"${taskId}",`)} ${AGENT_RUNTIME_CREDENTIALS_FILE} 2>/dev/null; do`,
    "  credential_polls=$((credential_polls + 1))",
    "  if [ \"$credential_polls\" -ge 180 ]; then echo 'Credential projection unavailable' >&2; exit 75; fi",
    "  sleep 1",
    "done",
  ].join("\n");
}
