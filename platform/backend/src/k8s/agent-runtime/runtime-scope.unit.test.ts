import { describe, expect, test } from "vitest";
import {
  kubernetesRuntimeNamespace,
  parseKubernetesRuntimeScope,
  serializeKubernetesRuntimeScope,
} from "./runtime-scope";

const ENVIRONMENT_ID = "abcdef00-1111-2222-3333-444455556666";

describe("Kubernetes runtime scope", () => {
  test("a workspace in the platform's cluster keeps the bare namespace existing rows have", () => {
    const scope = serializeKubernetesRuntimeScope({
      clusterEnvironmentId: null,
      namespace: "agents",
    });

    expect(scope).toBe("agents");
    expect(parseKubernetesRuntimeScope(scope)).toEqual({
      clusterEnvironmentId: null,
      namespace: "agents",
    });
  });

  test("a workspace in an environment's own cluster carries the environment", () => {
    const scope = serializeKubernetesRuntimeScope({
      clusterEnvironmentId: ENVIRONMENT_ID,
      namespace: "agents",
    });

    expect(scope).toBe(`${ENVIRONMENT_ID}/agents`);
    expect(parseKubernetesRuntimeScope(scope)).toEqual({
      clusterEnvironmentId: ENVIRONMENT_ID,
      namespace: "agents",
    });
    expect(kubernetesRuntimeNamespace(scope)).toBe("agents");
  });

  test("the same namespace in two clusters is two different scopes", () => {
    expect(
      serializeKubernetesRuntimeScope({
        clusterEnvironmentId: ENVIRONMENT_ID,
        namespace: "agents",
      }),
    ).not.toBe(
      serializeKubernetesRuntimeScope({
        clusterEnvironmentId: null,
        namespace: "agents",
      }),
    );
  });

  test.each([
    ["an empty scope", ""],
    ["an empty namespace", `${ENVIRONMENT_ID}/`],
    ["an environment that is not a UUID", "production/agents"],
    ["more than one separator", `${ENVIRONMENT_ID}/agents/extra`],
    ["an invalid namespace", "Agents_NS"],
  ])("rejects %s", (_name, scope) => {
    expect(() => parseKubernetesRuntimeScope(scope)).toThrow(
      /Not a Kubernetes Agent Runtime scope/,
    );
  });
});
