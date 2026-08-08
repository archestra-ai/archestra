import { describe, expect, test } from "vitest";
import type { InternalMcpCatalog } from "@/types";
import {
  assessDaggerMcpCompatibility,
  buildDaggerMcpServiceInput,
  DaggerMcpServicePrototype,
} from "./dagger-mcp-service-prototype";

function candidate(
  overrides: Partial<InternalMcpCatalog> = {},
): Pick<
  InternalMcpCatalog,
  "serverType" | "multitenant" | "deploymentSpecYaml" | "localConfig"
> {
  return {
    serverType: "local",
    multitenant: false,
    deploymentSpecYaml: null,
    localConfig: {
      dockerImage: "ghcr.io/example/mcp:sha-abc",
      command: "node",
      arguments: ["server.js"],
      transportType: "streamable-http",
      httpPort: 8787,
      httpPath: "/custom-mcp",
      environment: [],
      envFrom: [],
      imagePullSecrets: [],
    },
    ...overrides,
  };
}

describe("assessDaggerMcpCompatibility", () => {
  test("admits the narrow container-native HTTP shape", () => {
    expect(assessDaggerMcpCompatibility(candidate())).toEqual({
      compatible: true,
    });
  });

  test("keeps every Kubernetes-only shape on the Kubernetes runtime", () => {
    const value = assessDaggerMcpCompatibility(
      candidate({
        multitenant: true,
        deploymentSpecYaml: "apiVersion: apps/v1",
        localConfig: {
          transportType: "stdio",
          arguments: ["server.js"],
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              promptOnInstallation: true,
              mounted: true,
            },
          ],
          envFrom: [{ type: "secret", name: "shared-secret" }],
          serviceAccount: "mcp-sa",
          nodePort: 30080,
          imagePullSecrets: [{ source: "existing", name: "registry" }],
        },
      }),
    );

    expect(value).toEqual({
      compatible: false,
      reasons: [
        "multitenant",
        "custom-kubernetes-yaml",
        "stdio-transport",
        "image-required",
        "env-from",
        "image-pull-secrets",
        "service-account",
        "node-port",
        "mounted-secret",
        "image-entrypoint-with-arguments",
      ],
    });
  });
});

describe("buildDaggerMcpServiceInput", () => {
  test("normalizes command and arguments and preserves secret classification", () => {
    expect(
      buildDaggerMcpServiceInput({
        candidate: candidate(),
        serviceKey: "namespace/mcp-example",
        resolvedEnv: [
          { name: "LOG_LEVEL", value: "info" },
          { name: "API_TOKEN", value: "secret", secret: true },
        ],
        environment: {
          environmentId: "abcdef00-1111-2222-3333-444455556666",
          namespace: "mcp-runtime",
        },
      }),
    ).toEqual({
      serviceKey: "namespace/mcp-example",
      image: "ghcr.io/example/mcp:sha-abc",
      command: ["node", "server.js"],
      env: [
        { name: "LOG_LEVEL", value: "info" },
        { name: "API_TOKEN", value: "secret", secret: true },
      ],
      port: 8787,
      environment: {
        environmentId: "abcdef00-1111-2222-3333-444455556666",
        namespace: "mcp-runtime",
      },
    });
  });

  test("refuses to translate an unsupported catalog", () => {
    expect(() =>
      buildDaggerMcpServiceInput({
        candidate: candidate({
          localConfig: {
            command: "node",
            dockerImage: "node:24",
            transportType: "stdio",
          },
        }),
        serviceKey: "mcp-example",
        resolvedEnv: [],
      }),
    ).toThrow("stdio-transport");
  });
});

test("prototype adapter can be constructed without loading native bindings", () => {
  expect(new DaggerMcpServicePrototype()).toBeInstanceOf(
    DaggerMcpServicePrototype,
  );
});
