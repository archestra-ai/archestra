import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentRuntimePlatformEgressPolicy,
  buildAgentRuntimeSandbox,
  buildAgentRuntimeSecret,
  buildAgentRuntimeTurnScript,
  type KubernetesAgentRunLaunchSpec,
} from "./manifests";
import {
  AGENT_RUNTIME_TASK_LABEL,
  AGENT_RUNTIME_WORKSPACE_LABEL,
} from "./naming";

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
  workspaceStorageSize: "10Gi",
  imagePullSecrets: [],
  ownerReferences: undefined,
  effectiveNetworkPolicy: { source: "built_in", policy: null },
  inputFileCount: 0,
};

describe("buildAgentRuntimeSandbox", () => {
  it("does not inherit removed credentials or settings in a subsequent turn", () => {
    const script = buildAgentRuntimeTurnScript(
      {
        ...SPEC,
        runtimeScope: SPEC.namespace,
        env: { CURRENT_SETTING: "new-value" },
        secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "new-test-token" },
        command: [
          "/bin/sh",
          "-c",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
          'printf "%s|%s|%s|%s|%s" "${OPENAI_API_KEY-unset}" "${REMOVED_SETTING-unset}" "$CLAUDE_CODE_OAUTH_TOKEN" "$CURRENT_SETTING" "$IMAGE_SETTING"',
        ],
      },
      ["OPENAI_API_KEY", "REMOVED_SETTING", "CURRENT_SETTING"],
    );
    expect(
      execFileSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          OPENAI_API_KEY: "revoked-test-key",
          REMOVED_SETTING: "old",
          CURRENT_SETTING: "old",
          IMAGE_SETTING: "preserved",
        },
      }),
    ).toBe("unset|unset|new-test-token|new-value|preserved");
  });

  it("runs to completion instead of restarting a finished session", () => {
    const job = buildAgentRuntimeSandbox(SPEC);

    // A restarting workload would re-run an agent's side effects behind the
    // user's back, so both of these are load-bearing.
    expect(job.spec?.podTemplate.spec?.restartPolicy).toBe("Never");
  });

  it("passes the lifetime cap to Kubernetes as well as the reaper", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
    expect(buildAgentRuntimeSandbox(SPEC).spec.shutdownTime).toBe(
      "2026-09-08T13:00:00.000Z",
    );
    expect(
      buildAgentRuntimeSandbox({ ...SPEC, activeDeadlineSeconds: null }).spec
        .shutdownTime,
    ).toBeUndefined();
    vi.useRealTimers();
  });

  it("keeps secret values out of the pod spec", () => {
    const job = buildAgentRuntimeSandbox(SPEC);
    const container = job.spec?.podTemplate.spec?.containers[0];

    expect(JSON.stringify(job)).not.toContain("arch_secret");
    expect(container?.envFrom?.[0]?.secretRef?.name).toBe(
      "agent-run-deploy-app-11111111-env",
    );
  });

  it("gives terminal clients a UTF-8 locale with explicit override support", () => {
    const env =
      buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.spec?.containers[0]?.env;

    expect(env).toEqual(
      expect.arrayContaining([
        { name: "LANG", value: "C.UTF-8" },
        { name: "LC_ALL", value: "C.UTF-8" },
        { name: "TERM", value: "xterm-256color" },
      ]),
    );
    expect(
      buildAgentRuntimeSandbox({
        ...SPEC,
        env: { ...SPEC.env, TERM: "custom-terminal" },
      }).spec?.podTemplate.spec?.containers[0]?.env,
    ).toEqual(
      expect.arrayContaining([{ name: "TERM", value: "custom-terminal" }]),
    );
  });

  it("holds the entrypoint until declared input files are staged", () => {
    const container = buildAgentRuntimeSandbox({ ...SPEC, inputFileCount: 2 })
      .spec?.podTemplate.spec?.containers[0];
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
    const job = buildAgentRuntimeSandbox({ ...SPEC, secretEnv: {} });
    expect(job.spec?.podTemplate.spec?.containers[0]?.envFrom).toBeUndefined();
  });

  it("keeps the initial task label and the frozen workspace selector", () => {
    const labels =
      buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.metadata?.labels ?? {};
    expect(labels[AGENT_RUNTIME_TASK_LABEL]).toBe(SPEC.taskId);
    expect(labels[AGENT_RUNTIME_WORKSPACE_LABEL]).toBe(SPEC.frozenName);
  });

  it("does not mount a service account token", () => {
    expect(
      buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.spec
        ?.automountServiceAccountToken,
    ).toBe(false);
  });

  it("only grants privilege when the agent explicitly asked for it", () => {
    expect(
      buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.spec?.containers[0]
        ?.securityContext,
    ).toEqual({ allowPrivilegeEscalation: false });
    expect(
      buildAgentRuntimeSandbox({ ...SPEC, privileged: true }).spec?.podTemplate
        .spec?.containers[0]?.securityContext?.privileged,
    ).toBe(true);
  });

  it("requests durable storage for the workspace", () => {
    expect(
      buildAgentRuntimeSandbox(SPEC).spec.volumeClaimTemplates[0].spec.resources
        ?.requests?.storage,
    ).toBe("10Gi");
  });

  it("steers pods onto a dedicated pool only when a selector is configured", () => {
    const plain = buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.spec;
    expect(plain?.nodeSelector).toBeUndefined();
    expect(plain?.tolerations).toBeUndefined();

    const steered = buildAgentRuntimeSandbox({
      ...SPEC,
      nodeSelector: { "archestra-agent-runtime": "true" },
    }).spec?.podTemplate.spec;
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

  it("retains privileged development storage on the workspace volume", () => {
    const unprivileged = buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.spec;
    expect(unprivileged?.volumes).toEqual([]);

    const privileged = buildAgentRuntimeSandbox({ ...SPEC, privileged: true })
      .spec?.podTemplate.spec;
    expect(privileged?.containers[0]?.volumeMounts).toContainEqual({
      name: "workspace",
      mountPath: "/var/lib/docker",
      subPath: "docker",
    });
  });

  it("quotes a configured command so arguments cannot break out", () => {
    const job = buildAgentRuntimeSandbox({
      ...SPEC,
      command: ["claude", "--task", "it's a 'quoted' task; rm -rf /"],
    });
    const entrypoint = job.spec?.podTemplate.spec?.containers[0]?.env?.find(
      (entry) => entry.name === "ARCHESTRA_AGENT_RUNTIME_ENTRYPOINT",
    );

    expect(entrypoint?.value).toBe(
      [
        "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi",
        'if [ -f /var/run/archestra/session-interface ]; then export ARCHESTRA_AGENT_RUNTIME_INTERFACE="$(cat /var/run/archestra/session-interface)"; fi',
        `exec 'claude' '--task' 'it'\\''s a '\\''quoted'\\'' task; rm -rf /'`,
      ].join("\n"),
    );
  });

  it("falls back to the runtime-agent entrypoint when no command is set", () => {
    const entrypoint = buildAgentRuntimeSandbox(
      SPEC,
    ).spec?.podTemplate.spec?.containers[0]?.env?.find(
      (entry) => entry.name === "ARCHESTRA_AGENT_RUNTIME_ENTRYPOINT",
    );
    expect(entrypoint?.value).toBe(
      "if command -v archestra-agent-init >/dev/null 2>&1; then archestra-agent-init; fi\n" +
        'if [ -f /var/run/archestra/session-interface ]; then export ARCHESTRA_AGENT_RUNTIME_INTERFACE="$(cat /var/run/archestra/session-interface)"; fi\n' +
        "exec archestra-runtime-agent",
    );
  });

  it("applies resource requests and limits as configured", () => {
    const resources =
      buildAgentRuntimeSandbox(SPEC).spec?.podTemplate.spec?.containers[0]
        ?.resources;
    expect(resources?.requests).toEqual({ cpu: "500m", memory: "1Gi" });
    // No CPU limit by default: throttling an agent mid-turn reads as a hang.
    expect(resources?.limits).toEqual({ memory: "4Gi" });
  });
});

describe("the container bootstrap", () => {
  const script = () =>
    buildAgentRuntimeSandbox(
      SPEC,
    ).spec?.podTemplate.spec?.containers[0]?.command?.at(-1) ?? "";

  it("installs the workspace shell and starts agents under independent process groups", () => {
    expect(script()).toContain("exec /bin/sh -i");
    expect(script()).toContain('setsid /bin/sh "$turn.session"');
    expect(script()).not.toContain("tmux");
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
