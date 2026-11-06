import { createHash } from "node:crypto";
import { AGENT_RUNTIME_TIER_ENV } from "@/services/agent-runtime/runtime-contract";
import {
  buildAgentRuntimeSandbox,
  type KubernetesAgentRunLaunchSpec,
} from "./manifests";

/** Sanitization is allowlisted: user instructions, credentials, and task IDs never enter a pool. */
export function warmPoolTemplate(spec: KubernetesAgentRunLaunchSpec) {
  const sandbox = buildAgentRuntimeSandbox({
    ...spec,
    taskId: "",
    agentRuntimeId: "",
    frozenName: "warm",
    command: null,
    env: {},
    secretEnv: {},
    renewableCredentials: undefined,
    inputFileCount: 0,
    activeDeadlineSeconds: null,
    ownerReferences: undefined,
  });
  const pod = sandbox.spec.podTemplate.spec;
  if (!pod) throw new Error("Missing Agent pod template");
  const container = pod.containers[0];
  container.env = [
    { name: "LANG", value: "C.UTF-8" },
    { name: "LC_ALL", value: "C.UTF-8" },
    { name: "TERM", value: "xterm-256color" },
    { name: "ARCHESTRA_AGENT_RUNTIME_INPUT_FILE_COUNT", value: "0" },
    { name: "ARCHESTRA_AGENT_RUNTIME_WARM", value: "1" },
    // The Pod's tier outlives the claim, like the size it describes.
    ...(spec.tier ? [{ name: AGENT_RUNTIME_TIER_ENV, value: spec.tier }] : []),
  ];
  delete container.envFrom;
  pod.volumes = [];
  container.volumeMounts = container.volumeMounts?.filter(
    (mount) => mount.name !== "renewable-credentials",
  );
  container.readinessProbe = {
    exec: { command: ["tmux", "has-session", "-t", "agent"] },
    periodSeconds: 1,
    initialDelaySeconds: 1,
  };
  const blueprint = {
    podTemplate: { spec: pod },
    volumeClaimTemplates: sandbox.spec.volumeClaimTemplates,
    service: true,
    networkPolicyManagement: "Unmanaged",
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        scope: spec.poolScope,
        namespace: spec.namespace,
        blueprint,
        policy: spec.effectiveNetworkPolicy,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const name = `archestra-warm-${hash}`;
  return {
    name,
    spec: {
      ...blueprint,
      podTemplate: {
        ...blueprint.podTemplate,
        metadata: { labels: { "archestra.io/warm-pool": name } },
      },
    },
  };
}
