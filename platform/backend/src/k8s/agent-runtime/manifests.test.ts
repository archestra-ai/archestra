import { describe, expect, it } from "vitest";
import {
  buildAgentRuntimeJob,
  buildAgentRuntimePlatformEgressPolicy,
  buildAgentRuntimeSecret,
  type KubernetesAgentRunLaunchSpec,
} from "./manifests";
import { AGENT_RUNTIME_TASK_LABEL } from "./naming";

const SPEC: KubernetesAgentRunLaunchSpec = {
  taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  agentRuntimeId: "11111111-2222-3333-4444-555555555555",
  frozenName: "agent-run-deploy-app-11111111",
  namespace: "archestra-dev",
  image: "registry.example.test/agent-archestra:latest",
  command: null,
  privileged: false,
  nodeSelector: {},
  resources: { cpuRequest: "500m", memoryRequest: "1Gi", memoryLimit: "4Gi" },
  env: {
    ARCHESTRA_AGENT_RUNTIME_AGENT_ID: "11111111-2222-3333-4444-555555555555",
  },
  secretEnv: { ARCHESTRA_MCP_GATEWAY_TOKEN: "arch_secret" },
  activeDeadlineSeconds: 3600,
  ephemeralStorageLimit: "10Gi",
  imagePullSecrets: [],
  ownerReferences: undefined,
  effectiveNetworkPolicy: { source: "built_in", policy: null },
  inputFileCount: 0,
};

describe("buildAgentRuntimeJob", () => {
  it("runs to completion instead of restarting a finished session", () => {
    const job = buildAgentRuntimeJob(SPEC);

    // A restarting workload would re-run an agent's side effects behind the
    // user's back, so both of these are load-bearing.
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.template.spec?.restartPolicy).toBe("Never");
  });

  it("passes the lifetime cap to Kubernetes as well as the reaper", () => {
    expect(buildAgentRuntimeJob(SPEC).spec?.activeDeadlineSeconds).toBe(3600);
    expect(
      buildAgentRuntimeJob({ ...SPEC, activeDeadlineSeconds: null }).spec
        ?.activeDeadlineSeconds,
    ).toBeUndefined();
  });

  it("keeps secret values out of the pod spec", () => {
    const job = buildAgentRuntimeJob(SPEC);
    const container = job.spec?.template.spec?.containers[0];

    expect(JSON.stringify(job)).not.toContain("arch_secret");
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe(
      "agent-run-deploy-app-11111111-env",
    );
  });

  it("gives terminal clients a UTF-8 locale with explicit override support", () => {
    const env =
      buildAgentRuntimeJob(SPEC).spec?.template.spec?.containers[0]?.env;

    expect(env).toEqual(
      expect.arrayContaining([
        { name: "LANG", value: "C.UTF-8" },
        { name: "LC_ALL", value: "C.UTF-8" },
        { name: "TERM", value: "xterm-256color" },
      ]),
    );
    expect(
      buildAgentRuntimeJob({
        ...SPEC,
        env: { ...SPEC.env, TERM: "custom-terminal" },
      }).spec?.template.spec?.containers[0]?.env,
    ).toEqual(
      expect.arrayContaining([{ name: "TERM", value: "custom-terminal" }]),
    );
  });

  it("makes direct interactive shells join the agent session", () => {
    const env =
      buildAgentRuntimeJob(SPEC).spec?.template.spec?.containers[0]?.env;

    expect(env).toEqual(
      expect.arrayContaining([
        { name: "ENV", value: "/var/run/archestra/shell-init" },
        {
          name: "PROMPT_COMMAND",
          value: ". /var/run/archestra/shell-init",
        },
        {
          name: "ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH",
          value: "1",
        },
      ]),
    );
    expect(
      buildAgentRuntimeJob({
        ...SPEC,
        env: {
          ...SPEC.env,
          ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH: "0",
        },
      }).spec?.template.spec?.containers[0]?.env,
    ).toEqual(
      expect.arrayContaining([
        {
          name: "ARCHESTRA_AGENT_RUNTIME_AUTO_ATTACH",
          value: "0",
        },
      ]),
    );
  });

  it("holds the entrypoint until declared input files are staged", () => {
    const container = buildAgentRuntimeJob({ ...SPEC, inputFileCount: 2 }).spec
      ?.template.spec?.containers[0];
    expect(container?.env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ARCHESTRA_AGENT_RUNTIME_INPUT_FILE_COUNT",
          value: "2",
        }),
        expect.objectContaining({
          name: "ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR",
          value: "/var/run/archestra/attachments",
        }),
      ]),
    );
    expect(container?.command?.join("\n")).toContain(
      "/var/run/archestra/inputs-ready",
    );
  });

  it("omits envFrom entirely when there are no secrets to mount", () => {
    const job = buildAgentRuntimeJob({ ...SPEC, secretEnv: {} });
    expect(job.spec?.template.spec?.containers[0]?.envFrom).toBeUndefined();
  });

  it("selects pods by the task they carry, never by a mutable name", () => {
    const labels =
      buildAgentRuntimeJob(SPEC).spec?.template.metadata?.labels ?? {};
    expect(labels[AGENT_RUNTIME_TASK_LABEL]).toBe(SPEC.taskId);
    expect(Object.values(labels)).not.toContain(
      "agent-run-deploy-app-11111111",
    );
  });

  it("does not mount a service account token", () => {
    expect(
      buildAgentRuntimeJob(SPEC).spec?.template.spec
        ?.automountServiceAccountToken,
    ).toBe(false);
  });

  it("only grants privilege when the agent explicitly asked for it", () => {
    expect(
      buildAgentRuntimeJob(SPEC).spec?.template.spec?.containers[0]
        ?.securityContext,
    ).toEqual({ allowPrivilegeEscalation: false });
    expect(
      buildAgentRuntimeJob({ ...SPEC, privileged: true }).spec?.template.spec
        ?.containers[0]?.securityContext?.privileged,
    ).toBe(true);
  });

  it("bounds writable run scratch space", () => {
    expect(
      buildAgentRuntimeJob(SPEC).spec?.template.spec?.volumes?.[0]?.emptyDir
        ?.sizeLimit,
    ).toBe("10Gi");
  });

  it("steers pods onto a dedicated pool only when a selector is configured", () => {
    const plain = buildAgentRuntimeJob(SPEC).spec?.template.spec;
    expect(plain?.nodeSelector).toBeUndefined();
    expect(plain?.tolerations).toBeUndefined();

    const steered = buildAgentRuntimeJob({
      ...SPEC,
      nodeSelector: { "archestra-agent-runtime": "true" },
    }).spec?.template.spec;
    expect(steered?.nodeSelector).toEqual({
      "archestra-agent-runtime": "true",
    });
    expect(steered?.tolerations).toEqual([
      {
        key: "archestra-agent-runtime",
        operator: "Equal",
        value: "true",
        effect: "NoSchedule",
      },
    ]);
  });

  it("gives a privileged Agent Runtime run a real filesystem for /var/lib/docker", () => {
    const unprivileged = buildAgentRuntimeJob(SPEC).spec?.template.spec;
    expect(unprivileged?.volumes?.map((volume) => volume.name)).toEqual([
      "archestra-run",
    ]);

    const privileged = buildAgentRuntimeJob({ ...SPEC, privileged: true }).spec
      ?.template.spec;
    expect(privileged?.volumes).toContainEqual({
      name: "docker-lib",
      emptyDir: { sizeLimit: "10Gi" },
    });
    expect(privileged?.containers[0]?.volumeMounts).toContainEqual({
      name: "docker-lib",
      mountPath: "/var/lib/docker",
    });
  });

  it("quotes a configured command so arguments cannot break out", () => {
    const job = buildAgentRuntimeJob({
      ...SPEC,
      command: ["claude", "--task", "it's a 'quoted' task; rm -rf /"],
    });
    const entrypoint = job.spec?.template.spec?.containers[0]?.env?.find(
      (entry) => entry.name === "ARCHESTRA_AGENT_RUNTIME_ENTRYPOINT",
    );

    expect(entrypoint?.value).toBe(
      [
        "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi",
        `exec 'claude' '--task' 'it'\\''s a '\\''quoted'\\'' task; rm -rf /'`,
      ].join("\n"),
    );
  });

  it("falls back to the runtime-agent entrypoint when no command is set", () => {
    const entrypoint = buildAgentRuntimeJob(
      SPEC,
    ).spec?.template.spec?.containers[0]?.env?.find(
      (entry) => entry.name === "ARCHESTRA_AGENT_RUNTIME_ENTRYPOINT",
    );
    expect(entrypoint?.value).toBe(
      "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi\n" +
        "exec archestra-runtime-agent",
    );
  });

  it("applies resource requests and limits as configured", () => {
    const resources =
      buildAgentRuntimeJob(SPEC).spec?.template.spec?.containers[0]?.resources;
    expect(resources?.requests).toEqual({ cpu: "500m", memory: "1Gi" });
    // No CPU limit by default: throttling an agent mid-turn reads as a hang.
    expect(resources?.limits).toEqual({ memory: "4Gi" });
  });
});

describe("the container bootstrap", () => {
  const script = () =>
    buildAgentRuntimeJob(SPEC).spec?.template.spec?.containers[0]
      ?.command?.[2] ?? "";

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

  it("connects stdout capture before the Agent process can emit output", () => {
    expect(script().indexOf("tmux pipe-pane")).toBeLessThan(
      script().indexOf("tmux respawn-pane"),
    );
    expect(script()).not.toContain("sleep 10");
  });

  it("drains the stdout mirror before the pane exits", () => {
    // A one-shot agent writes its whole answer in its final instant; without
    // the drain the pane exit tears down pipe-pane first and the transcript
    // ends up empty.
    expect(script()).toContain('agent session exited"; sleep 2; exit');
  });

  it("lets terminal wheel events scroll tmux history", () => {
    expect(script()).toContain("tmux set-option -t agent mouse on");
    expect(script().indexOf("mouse on")).toBeLessThan(
      script().indexOf("tmux respawn-pane"),
    );
  });

  it("shows runtime-reported attention states in every attached terminal", () => {
    expect(script()).toContain("@archestra_attention 0");
    expect(script()).toContain("@archestra_attention_label");
    expect(script()).toContain("status-left");
    expect(script().indexOf("status-left")).toBeLessThan(
      script().indexOf("tmux respawn-pane"),
    );
  });

  it("installs a portable attach command for exec clients", () => {
    expect(script()).toContain("> /var/run/archestra/attach");
    expect(script()).toContain("chmod 755 /var/run/archestra/attach");
    expect(script()).toContain("exec /var/run/archestra/attach");
    expect(script().indexOf("/var/run/archestra/attach")).toBeLessThan(
      script().indexOf("tmux new-session"),
    );
  });
});

describe("buildAgentRuntimeSecret", () => {
  it("base64-encodes values as Kubernetes requires", () => {
    const secret = buildAgentRuntimeSecret(SPEC);
    expect(secret.data?.ARCHESTRA_MCP_GATEWAY_TOKEN).toBe(
      Buffer.from("arch_secret", "utf8").toString("base64"),
    );
  });
});

describe("buildAgentRuntimePlatformEgressPolicy", () => {
  it("selects only this Agent Runtime run's pods so MCP pods are unaffected", () => {
    const policy = buildAgentRuntimePlatformEgressPolicy({
      spec: SPEC,
      platformNamespace: "archestra",
      platformPodLabels: { "app.kubernetes.io/name": "archestra" },
      platformPorts: [9000],
    });

    expect(policy.spec?.podSelector?.matchLabels).toEqual({
      [AGENT_RUNTIME_TASK_LABEL]: SPEC.taskId,
    });
    expect(policy.spec?.policyTypes).toEqual(["Egress"]);
    expect(policy.spec?.egress?.[0]?.ports?.[0]?.port).toBe(9000);
  });

  it("permits DNS, without which the pod cannot resolve the platform at all", () => {
    // Once any egress policy selects a pod, its egress is clamped to the union
    // of the selecting policies — and no other policy selects Agent Runtime pods, so
    // omitting DNS here would break every session at its first call.
    const policy = buildAgentRuntimePlatformEgressPolicy({
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
