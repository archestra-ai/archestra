import { describe, expect, it } from "vitest";
import {
  buildRunnerEnvironmentEgressPolicy,
  buildRunnerJob,
  buildRunnerPlatformEgressPolicy,
  buildRunnerSecret,
  type KubernetesRunnerLaunchSpec,
} from "./manifests";
import { RUNNER_TASK_LABEL } from "./naming";

const SPEC: KubernetesRunnerLaunchSpec = {
  taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  runnerId: "11111111-2222-3333-4444-555555555555",
  frozenName: "runner-deploy-app-11111111",
  namespace: "archestra-dev",
  image: "registry.example.test/agent-archestra:latest",
  command: null,
  privileged: false,
  resources: { cpuRequest: "500m", memoryRequest: "1Gi", memoryLimit: "4Gi" },
  env: {
    ARCHESTRA_AGENT_BACKGROUND_EXECUTION_AGENT_ID:
      "11111111-2222-3333-4444-555555555555",
  },
  secretEnv: { ARCHESTRA_MCP_GATEWAY_TOKEN: "arch_secret" },
  activeDeadlineSeconds: 3600,
  imagePullSecrets: [],
  ownerReferences: undefined,
  effectiveNetworkPolicy: { source: "built_in", policy: null },
};

describe("buildRunnerJob", () => {
  it("runs to completion instead of restarting a finished session", () => {
    const job = buildRunnerJob(SPEC);

    // A restarting workload would re-run an agent's side effects behind the
    // user's back, so both of these are load-bearing.
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.template.spec?.restartPolicy).toBe("Never");
  });

  it("passes the lifetime cap to Kubernetes as well as the reaper", () => {
    expect(buildRunnerJob(SPEC).spec?.activeDeadlineSeconds).toBe(3600);
    expect(
      buildRunnerJob({ ...SPEC, activeDeadlineSeconds: null }).spec
        ?.activeDeadlineSeconds,
    ).toBeUndefined();
  });

  it("keeps secret values out of the pod spec", () => {
    const job = buildRunnerJob(SPEC);
    const container = job.spec?.template.spec?.containers[0];

    expect(JSON.stringify(job)).not.toContain("arch_secret");
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe(
      "runner-deploy-app-11111111-env",
    );
  });

  it("omits envFrom entirely when there are no secrets to mount", () => {
    const job = buildRunnerJob({ ...SPEC, secretEnv: {} });
    expect(job.spec?.template.spec?.containers[0]?.envFrom).toBeUndefined();
  });

  it("selects pods by the task they carry, never by a mutable name", () => {
    const labels = buildRunnerJob(SPEC).spec?.template.metadata?.labels ?? {};
    expect(labels[RUNNER_TASK_LABEL]).toBe(SPEC.taskId);
    expect(Object.values(labels)).not.toContain("runner-deploy-app-11111111");
  });

  it("does not mount a service account token", () => {
    expect(
      buildRunnerJob(SPEC).spec?.template.spec?.automountServiceAccountToken,
    ).toBe(false);
  });

  it("only grants privilege when the agent explicitly asked for it", () => {
    expect(
      buildRunnerJob(SPEC).spec?.template.spec?.containers[0]?.securityContext,
    ).toBeUndefined();
    expect(
      buildRunnerJob({ ...SPEC, privileged: true }).spec?.template.spec
        ?.containers[0]?.securityContext?.privileged,
    ).toBe(true);
  });

  it("quotes a configured command so arguments cannot break out", () => {
    const job = buildRunnerJob({
      ...SPEC,
      command: ["claude", "--task", "it's a 'quoted' task; rm -rf /"],
    });
    const entrypoint = job.spec?.template.spec?.containers[0]?.env?.find(
      (entry) =>
        entry.name === "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ENTRYPOINT",
    );

    expect(entrypoint?.value).toBe(
      [
        "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi",
        `exec 'claude' '--task' 'it'\\''s a '\\''quoted'\\'' task; rm -rf /'`,
      ].join("\n"),
    );
  });

  it("falls back to the runner-agent entrypoint when no command is set", () => {
    const entrypoint = buildRunnerJob(
      SPEC,
    ).spec?.template.spec?.containers[0]?.env?.find(
      (entry) =>
        entry.name === "ARCHESTRA_AGENT_BACKGROUND_EXECUTION_ENTRYPOINT",
    );
    expect(entrypoint?.value).toBe(
      "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi\n" +
        "exec archestra-runner-agent",
    );
  });

  it("applies resource requests and limits as configured", () => {
    const resources =
      buildRunnerJob(SPEC).spec?.template.spec?.containers[0]?.resources;
    expect(resources?.requests).toEqual({ cpu: "500m", memory: "1Gi" });
    // No CPU limit by default: throttling an agent mid-turn reads as a hang.
    expect(resources?.limits).toEqual({ memory: "4Gi" });
  });
});

describe("the container bootstrap", () => {
  const script = () =>
    buildRunnerJob(SPEC).spec?.template.spec?.containers[0]?.command?.[2] ?? "";

  it("fails with a distinct code when the image cannot host a session", () => {
    // Distinct from any exit code the agent itself produces, so "this image
    // has no tmux" never reads as "your agent failed".
    expect(script()).toContain("command -v tmux");
    expect(script()).toContain("exit 78");
  });

  it("creates the steer FIFO and holds PID 1 for the session's lifetime", () => {
    expect(script()).toContain("mkfifo -m 600");
    expect(script()).toContain("tmux has-session -t agent");
  });

  it("propagates the Agent process exit code to the Job", () => {
    expect(script()).toContain('status=$?; printf "%s\\n" "$status"');
    expect(script()).toContain('exit "$(cat /var/run/archestra/exit-code)"');
  });
});

describe("buildRunnerSecret", () => {
  it("base64-encodes values as Kubernetes requires", () => {
    const secret = buildRunnerSecret(SPEC);
    expect(secret.data?.ARCHESTRA_MCP_GATEWAY_TOKEN).toBe(
      Buffer.from("arch_secret", "utf8").toString("base64"),
    );
  });
});

describe("buildRunnerPlatformEgressPolicy", () => {
  it("selects only this runner's pods so MCP pods are unaffected", () => {
    const policy = buildRunnerPlatformEgressPolicy({
      spec: SPEC,
      platformNamespace: "archestra",
      platformPodLabels: { "app.kubernetes.io/name": "archestra" },
      platformPorts: [9000],
    });

    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      [RUNNER_TASK_LABEL]: SPEC.taskId,
    });
    expect(policy.spec?.policyTypes).toEqual(["Egress"]);
    expect(policy.spec?.egress?.[0]?.ports?.[0]?.port).toBe(9000);
  });

  it("permits DNS, without which the pod cannot resolve the platform at all", () => {
    // Once any egress policy selects a pod, its egress is clamped to the union
    // of the selecting policies — and no other policy selects runner pods, so
    // omitting DNS here would break every session at its first call.
    const policy = buildRunnerPlatformEgressPolicy({
      spec: SPEC,
      platformNamespace: "archestra",
      platformPodLabels: { "app.kubernetes.io/name": "archestra" },
      platformPorts: [9000],
    });

    const dnsRules = (policy.spec?.egress ?? []).filter((rule) =>
      rule.ports?.some((port) => port.port === 53),
    );
    expect(dnsRules.length).toBeGreaterThanOrEqual(2);
    expect(
      dnsRules.some((rule) =>
        rule.to?.some(
          (target) =>
            target.podSelector?.matchLabels?.["k8s-app"] === "kube-dns",
        ),
      ),
    ).toBe(true);
    // Clusters whose resolver is not that labelled pod need the CIDR fallback.
    expect(
      dnsRules.some((rule) =>
        rule.to?.some((target) => target.ipBlock?.cidr === "0.0.0.0/0"),
      ),
    ).toBe(true);
    for (const rule of dnsRules) {
      const protocols = (rule.ports ?? []).map((port) => port.protocol);
      expect(protocols).toContain("UDP");
      expect(protocols).toContain("TCP");
    }
  });
});

describe("buildRunnerEnvironmentEgressPolicy", () => {
  it("gives the built-in Environment public egress without private-network access", () => {
    const policy = buildRunnerEnvironmentEgressPolicy(SPEC);
    const publicRule = policy.spec?.egress?.find((rule) =>
      rule.to?.some((target) => target.ipBlock?.cidr === "0.0.0.0/0"),
    );

    expect(policy.metadata?.name).toBe("runner-deploy-app-11111111-egress");
    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      [RUNNER_TASK_LABEL]: SPEC.taskId,
    });
    expect(publicRule?.to?.[0]?.ipBlock?.except).toContain("10.0.0.0/8");
  });

  it("uses the shared restricted-policy rules for an Agent Environment", () => {
    const policy = buildRunnerEnvironmentEgressPolicy({
      ...SPEC,
      effectiveNetworkPolicy: {
        source: "environment",
        policy: {
          egressMode: "restricted",
          domainPreset: "none",
          allowedDomains: [],
          allowedCidrs: ["203.0.113.0/24"],
        },
      },
    });

    expect(
      policy.spec?.egress?.some((rule) =>
        rule.to?.some((target) => target.ipBlock?.cidr === "203.0.113.0/24"),
      ),
    ).toBe(true);
    expect(
      policy.spec?.egress?.some((rule) =>
        rule.to?.some((target) => target.ipBlock?.cidr === "0.0.0.0/0"),
      ),
    ).toBe(false);
  });
});
