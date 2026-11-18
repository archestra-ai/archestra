import {
  ENVIRONMENT_CLUSTER_BUSY_CODE,
  ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  chooseEnvironmentCluster,
  clusterServerLabel,
  EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
  environmentClusterCreateError,
  environmentClusterCreateFields,
  environmentClusterDraftFor,
  environmentClusterUpdateFields,
  environmentDeleteBlock,
  suggestedAgentRuntimePlatformUrl,
} from "./environment-cluster";

const KUBECONFIG = "apiVersion: v1\nkind: Config\n";
const ownCluster = {
  ...EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
  ownCluster: true,
  connection: "kubeconfig" as const,
  kubeconfig: KUBECONFIG,
};
const agentCluster = {
  ...EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
  ownCluster: true,
  connection: "agent" as const,
};
const boundEnvironment = {
  kubeconfigServer: "https://cluster.example:6443",
  clusterAgent: false,
  agentRuntimePlatformBaseUrl: "https://platform.example",
};
const agentEnvironment = {
  kubeconfigServer: "https://agent.example:8443",
  clusterAgent: true,
  agentRuntimePlatformBaseUrl: "http://archestra-cluster-agent:8080",
};
const platformEnvironment = {
  kubeconfigServer: null,
  clusterAgent: false,
  agentRuntimePlatformBaseUrl: null,
};

function apiError(internalCode: string | undefined, message: string) {
  return {
    error: {
      message,
      type: "api_conflict_error",
      ...(internalCode ? { internal_code: internalCode } : {}),
    },
  };
}

describe("environmentDeleteBlock", () => {
  it("recognizes a failed cleanup of the cluster", () => {
    expect(
      environmentDeleteBlock(
        apiError(
          ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE,
          "cluster unreachable",
        ),
      ),
    ).toEqual({ kind: "cleanup-failed", message: "cluster unreachable" });
  });

  it("recognizes a cluster that is still being deployed into", () => {
    expect(
      environmentDeleteBlock(
        apiError(ENVIRONMENT_CLUSTER_BUSY_CODE, "1 operation is still running"),
      ),
    ).toEqual({ kind: "busy", message: "1 operation is still running" });
  });

  it("leaves every other error to the generic handling", () => {
    expect(
      environmentDeleteBlock(apiError(undefined, "still has catalog items")),
    ).toBeNull();
    expect(environmentDeleteBlock(new Error("network"))).toBeNull();
  });
});

describe("environmentClusterDraftFor", () => {
  it("starts a new environment in the platform's cluster", () => {
    expect(environmentClusterDraftFor(null)).toEqual(
      EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
    );
  });

  it("never prefills the stored kubeconfig", () => {
    expect(environmentClusterDraftFor(boundEnvironment)).toEqual({
      ownCluster: true,
      connection: "kubeconfig",
      kubeconfig: "",
      agentUrl: "",
      agentToken: "",
      agentCa: "",
      agentRuntimePlatformBaseUrl: "https://platform.example",
    });
  });

  it("shows the agent's address, never its token", () => {
    expect(environmentClusterDraftFor(agentEnvironment)).toMatchObject({
      ownCluster: true,
      connection: "agent",
      agentUrl: "https://agent.example:8443",
      agentToken: "",
    });
  });

  it("shows an environment without a kubeconfig as the platform's cluster", () => {
    expect(environmentClusterDraftFor(platformEnvironment).ownCluster).toBe(
      false,
    );
  });
});

describe("suggestedAgentRuntimePlatformUrl", () => {
  it("picks the external https address over the in-cluster one", () => {
    expect(
      suggestedAgentRuntimePlatformUrl([
        "http://archestra.default.svc:9000",
        "https://api.example.com",
      ]),
    ).toBe("https://api.example.com");
  });

  it("drops a trailing slash and the proxy's /v1 path", () => {
    expect(suggestedAgentRuntimePlatformUrl(["https://api.example.com/"])).toBe(
      "https://api.example.com",
    );
    expect(
      suggestedAgentRuntimePlatformUrl(["https://api.example.com/v1"]),
    ).toBe("https://api.example.com");
  });

  it("suggests nothing without an https address", () => {
    expect(
      suggestedAgentRuntimePlatformUrl(["http://archestra.default.svc:9000"]),
    ).toBe("");
    expect(suggestedAgentRuntimePlatformUrl([])).toBe("");
  });
});

describe("chooseEnvironmentCluster", () => {
  const suggested = "https://api.example.com";

  it("fills an empty platform URL when a kubeconfig is chosen", () => {
    expect(
      chooseEnvironmentCluster(
        EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
        "kubeconfig",
        suggested,
      ),
    ).toEqual({
      ...EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
      ownCluster: true,
      connection: "kubeconfig",
      agentRuntimePlatformBaseUrl: suggested,
    });
  });

  it("leaves the platform URL to Archestra when the cluster agent is chosen", () => {
    expect(
      chooseEnvironmentCluster(
        EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
        "agent",
        suggested,
      ),
    ).toEqual(agentCluster);
  });

  it("keeps a platform URL the admin entered", () => {
    const draft = {
      ...EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
      agentRuntimePlatformBaseUrl: "https://archestra.internal",
    };
    expect(
      chooseEnvironmentCluster(draft, "kubeconfig", suggested)
        .agentRuntimePlatformBaseUrl,
    ).toBe("https://archestra.internal");
  });

  it("leaves the platform URL alone when the platform's cluster is chosen", () => {
    expect(
      chooseEnvironmentCluster(
        EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
        "platform",
        suggested,
      ),
    ).toEqual(EMPTY_ENVIRONMENT_CLUSTER_DRAFT);
  });
});

describe("environmentClusterCreateError", () => {
  it("asks nothing of an environment in the platform's cluster", () => {
    expect(
      environmentClusterCreateError({
        draft: EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
        namespace: "",
      }),
    ).toBeNull();
  });

  it("requires a kubeconfig for an environment with its own cluster", () => {
    expect(
      environmentClusterCreateError({
        draft: { ...ownCluster, kubeconfig: "  " },
        namespace: "workloads",
      }),
    ).toMatch(/kubeconfig/i);
  });

  it("requires the namespace of that cluster", () => {
    expect(
      environmentClusterCreateError({ draft: ownCluster, namespace: " " }),
    ).toMatch(/namespace/i);
  });

  it("asks for the agent's address and token, and the namespace", () => {
    expect(
      environmentClusterCreateError({
        draft: { ...agentCluster, agentUrl: "https://agent.example" },
        namespace: "workloads",
      }),
    ).toMatch(/address and token/);
    const ready = {
      ...agentCluster,
      agentUrl: "https://agent.example",
      agentToken: "secret",
    };
    expect(
      environmentClusterCreateError({ draft: ready, namespace: " " }),
    ).toMatch(/namespace/i);
    expect(
      environmentClusterCreateError({ draft: ready, namespace: "workloads" }),
    ).toBeNull();
  });

  it("accepts a kubeconfig with a namespace", () => {
    expect(
      environmentClusterCreateError({
        draft: ownCluster,
        namespace: "workloads",
      }),
    ).toBeNull();
  });
});

describe("environmentClusterCreateFields", () => {
  it("sends no cluster fields for the platform's cluster", () => {
    expect(
      environmentClusterCreateFields({
        ...EMPTY_ENVIRONMENT_CLUSTER_DRAFT,
        // Typed before the person switched back to the platform's cluster.
        kubeconfig: KUBECONFIG,
      }),
    ).toEqual({});
  });

  it("sends the agent's address and token, and no kubeconfig", () => {
    expect(
      environmentClusterCreateFields({
        ...agentCluster,
        kubeconfig: KUBECONFIG,
        agentUrl: " https://agent.example ",
        agentToken: " secret ",
      }),
    ).toEqual({
      clusterAgent: { url: "https://agent.example", token: "secret" },
    });
  });

  it("sends the kubeconfig, and the platform URL only when given", () => {
    expect(environmentClusterCreateFields(ownCluster)).toEqual({
      kubeconfig: KUBECONFIG,
    });
    expect(
      environmentClusterCreateFields({
        ...ownCluster,
        agentRuntimePlatformBaseUrl: " https://platform.example ",
      }),
    ).toEqual({
      kubeconfig: KUBECONFIG,
      agentRuntimePlatformBaseUrl: "https://platform.example",
    });
  });
});

describe("environmentClusterUpdateFields", () => {
  it("sends nothing when nothing changed", () => {
    expect(
      environmentClusterUpdateFields({
        draft: environmentClusterDraftFor(boundEnvironment),
        environment: boundEnvironment,
      }),
    ).toEqual({});
  });

  it("sends a replacement kubeconfig", () => {
    expect(
      environmentClusterUpdateFields({
        draft: {
          ...environmentClusterDraftFor(boundEnvironment),
          kubeconfig: KUBECONFIG,
        },
        environment: boundEnvironment,
      }),
    ).toEqual({ kubeconfig: KUBECONFIG });
  });

  it("sends a replacement agent token", () => {
    expect(
      environmentClusterUpdateFields({
        draft: {
          ...environmentClusterDraftFor(agentEnvironment),
          agentToken: "new-secret",
        },
        environment: agentEnvironment,
      }),
    ).toEqual({ clusterAgentToken: "new-secret" });
  });

  it("clears the platform URL when it is emptied", () => {
    expect(
      environmentClusterUpdateFields({
        draft: {
          ...environmentClusterDraftFor(boundEnvironment),
          agentRuntimePlatformBaseUrl: "",
        },
        environment: boundEnvironment,
      }),
    ).toEqual({ agentRuntimePlatformBaseUrl: null });
  });

  it("never sends cluster fields for an environment in the platform's cluster", () => {
    expect(
      environmentClusterUpdateFields({
        draft: {
          ...ownCluster,
          agentRuntimePlatformBaseUrl: "https://x.example",
        },
        environment: platformEnvironment,
      }),
    ).toEqual({});
  });
});

describe("clusterServerLabel", () => {
  it("shows the host and port of the API server", () => {
    expect(clusterServerLabel("https://cluster.example:6443")).toBe(
      "cluster.example:6443",
    );
    expect(clusterServerLabel("https://cluster.example/path")).toBe(
      "cluster.example",
    );
  });

  it("falls back to the stored value when it is not a URL", () => {
    expect(clusterServerLabel("not a url")).toBe("not a url");
  });
});
