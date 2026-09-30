// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Exercises literal template syntax and supplied scalar values.

import type * as k8s from "@kubernetes/client-node";
import * as yaml from "js-yaml";
import { describe, expect, test } from "vitest";
import type { InternalMcpCatalog } from "@/types/mcp-catalog";
import {
  findUnsafeDeploymentYamlPlaceholders,
  generateDeploymentYamlTemplate,
  resolvePlaceholders,
  validateDeploymentYaml,
} from "./k8s-yaml-generator";

const context = {
  deploymentName: "mcp-example",
  serverId: "server-id",
  serverName: "example",
  namespace: "example",
  dockerImage: "registry.example.com/mcp:1",
  secretName: "mcp-example-secrets",
  serviceAccount: "custom-account",
  command: "node",
  arguments: ["--message", 'quote: " and newline\nkept'],
};

function template(
  podFields: Record<string, unknown> = {},
  metadata: k8s.V1ObjectMeta = {},
): string {
  return yaml.dump({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "${archestra.deployment_name}", ...metadata },
    spec: {
      template: {
        spec: {
          containers: [
            { name: "mcp-server", image: "${archestra.docker_image}" },
          ],
          ...podFields,
        },
      },
    },
  });
}

function resolved(source: string, input: string): k8s.V1Deployment {
  return yaml.load(
    resolvePlaceholders(source, context, { INPUT: input }),
  ) as k8s.V1Deployment;
}

describe("deployment YAML installation placeholders", () => {
  test("preserves primitive types of unquoted catalog-owned placeholders", () => {
    const source = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata: {}",
      "spec:",
      "  replicas: ${env.REPLICAS}",
      "  template:",
      "    spec:",
      "      automountServiceAccountToken: ${env.MOUNT_TOKEN}",
      "      securityContext: {runAsUser: ${env.USER_ID}, runAsGroup: ${env.GROUP_ID}, fsGroup: ${env.FS_GROUP}}",
      "      containers:",
      "        - name: mcp-server",
      "          image: test:1",
      "          ports: [{containerPort: ${env.PORT}}]",
    ].join("\n");
    const values = {
      REPLICAS: "3",
      MOUNT_TOKEN: "false",
      PORT: "8080",
      USER_ID: "null",
      GROUP_ID: "~",
      FS_GROUP: "",
    };
    const inputDefinitions = {
      localConfig: {
        environment: Object.entries(values).map(([key, value]) => ({
          key,
          value,
          type: "plain_text" as const,
          promptOnInstallation: false,
        })),
      },
    };
    expect(validateDeploymentYaml(source, inputDefinitions).valid).toBe(true);
    expect(
      yaml.load(
        resolvePlaceholders(source, { ...context, inputDefinitions }, values),
      ),
    ).toMatchObject({
      spec: {
        replicas: 3,
        template: {
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              runAsUser: null,
              runAsGroup: null,
              fsGroup: null,
            },
            containers: [{ ports: [{ containerPort: 8080 }] }],
          },
        },
      },
    });
  });

  test("keeps quoted, explicitly tagged and block catalog placeholders as strings", () => {
    const source = `${template()}values:\n  plain: &number \${env.NUMBER}\n  alias: *number\n  single: '\${env.NUMBER}'\n  double: "\${env.NUMBER}"\n  tagged: !!str \${env.NUMBER}\n  block: |-\n    \${env.NUMBER}\n`;
    const inputDefinitions = {
      localConfig: {
        environment: [
          {
            key: "NUMBER",
            value: "3",
            type: "plain_text" as const,
            promptOnInstallation: false,
          },
        ],
      },
    };
    expect(
      yaml.load(
        resolvePlaceholders(
          source,
          { ...context, inputDefinitions },
          { NUMBER: "3" },
        ),
      ),
    ).toMatchObject({
      values: {
        plain: 3,
        alias: 3,
        single: "3",
        double: "3",
        tagged: "3",
        block: "3",
      },
    });
  });

  test.each([
    "[1, 2]",
    "!!bool false",
    "*alias",
    "3\ninjected: true",
  ])("does not interpret catalog placeholder data as YAML structure: %s", (value) => {
    const source = `${template()}value: \${env.VALUE}\n`;
    const inputDefinitions = {
      localConfig: {
        environment: [
          {
            key: "VALUE",
            value,
            type: "plain_text" as const,
            promptOnInstallation: false,
          },
        ],
      },
    };
    const output = yaml.load(
      resolvePlaceholders(
        source,
        { ...context, inputDefinitions },
        { VALUE: value },
      ),
    );
    expect(output).toHaveProperty("value", value);
    expect(output).not.toHaveProperty("injected");
  });

  test("a generated template keeps multiline input inside its environment value", () => {
    const source = generateDeploymentYamlTemplate({
      ...context,
      environment: [
        { key: "INPUT", type: "plain_text", promptOnInstallation: true },
      ],
    });
    const input = [
      "ordinary text",
      "      serviceAccount: example-account",
      "      volumes:",
      "        - name: token",
      "          projected:",
      "            sources:",
      "              - serviceAccountToken:",
      "                  path: token",
      "      initContainers:",
      "        - name: example-init",
      "          image: registry.example.com/mcp:1",
    ].join("\n");
    const pod = resolved(source, input).spec?.template.spec;
    expect(pod?.containers[0].env).toEqual([{ name: "INPUT", value: input }]);
    expect(pod).not.toHaveProperty("serviceAccount");
    expect(pod?.volumes).toBeUndefined();
    expect(pod?.initContainers).toBeUndefined();
  });

  test("preserves catalog-owned values in deployment fields", () => {
    const definitions = {
      localConfig: {
        command: "node",
        environment: [
          {
            key: "ACCOUNT",
            type: "plain_text",
            promptOnInstallation: false,
            value: "catalog-account",
          },
          {
            key: "IMAGE",
            type: "plain_text",
            promptOnInstallation: false,
            value: "registry.example.com/mcp:1",
          },
          {
            key: "MEMORY",
            type: "plain_text",
            promptOnInstallation: false,
            value: "256Mi",
          },
          {
            key: "REGION",
            type: "plain_text",
            promptOnInstallation: false,
            value: "${user_config.region}",
          },
        ],
      },
      userConfig: {
        region: {
          type: "string",
          title: "Region",
          description: "",
          promptOnInstallation: false,
          default: "west",
        },
      },
    } satisfies Partial<InternalMcpCatalog>;
    const source = template(
      {
        serviceAccountName: "${env.ACCOUNT}",
        containers: [
          {
            name: "mcp-server",
            image: "${env.IMAGE}",
            resources: { requests: { memory: "${env.MEMORY}" } },
          },
        ],
      },
      { annotations: { "example.com/region": "${env.REGION}" } },
    );
    expect(findUnsafeDeploymentYamlPlaceholders(source, definitions)).toEqual(
      [],
    );
    expect(validateDeploymentYaml(source, definitions).valid).toBe(true);
    const result = yaml.load(
      resolvePlaceholders(
        source,
        { ...context, inputDefinitions: definitions },
        {
          ACCOUNT: "catalog-account",
          IMAGE: "registry.example.com/mcp:1",
          MEMORY: "256Mi",
          REGION: "west",
        },
      ),
    );
    expect(result).toMatchObject({
      spec: {
        template: {
          spec: {
            serviceAccountName: "catalog-account",
            containers: [
              {
                image: "registry.example.com/mcp:1",
                resources: { requests: { memory: "256Mi" } },
              },
            ],
          },
        },
      },
      metadata: { annotations: { "example.com/region": "west" } },
    });
  });

  test.each([
    ["prompted", { promptOnInstallation: true }],
    ["credential-bound", { credentialId: "credential" }],
    ["secret", { type: "secret" as const }],
    ["connection input", { value: "${user_config.region}" }],
    ["unknown connection input", { value: "${user_config.unknown}" }],
  ])("keeps %s environment sources restricted in deployment fields", (_label, overrides) => {
    const definitions = {
      localConfig: {
        command: "node",
        environment: [
          {
            key: "INPUT",
            type: "plain_text" as const,
            promptOnInstallation: false,
            value: "catalog-account",
            ...overrides,
          },
        ],
      },
      userConfig: {
        region: {
          type: "string" as const,
          title: "Region",
          description: "",
          promptOnInstallation: true,
        },
      },
    };
    const source = template({ serviceAccountName: "${env.INPUT}" });
    expect(
      findUnsafeDeploymentYamlPlaceholders(source, definitions).join("\n"),
    ).toContain("serviceAccountName");
    expect(validateDeploymentYaml(source, definitions).valid).toBe(false);
    expect(() =>
      resolvePlaceholders(
        source,
        { ...context, inputDefinitions: definitions },
        { INPUT: "value" },
      ),
    ).toThrow(/serviceAccountName/);
  });

  test("defers source-dependent validation without catalog definitions", () => {
    const source = template({ serviceAccountName: "${env.INPUT}" });
    const result = validateDeploymentYaml(source);
    expect(result.valid).toBe(true);
    expect(result.warnings.join("\n")).toContain("serviceAccountName");
    expect(findUnsafeDeploymentYamlPlaceholders(source).join("\n")).toContain(
      "serviceAccountName",
    );
    expect(validateDeploymentYaml(source, {}).valid).toBe(false);
  });

  test.each([
    "prompted",
    "credential",
    "oauth",
    "unknown",
    "cycle",
  ])("tracks %s sources through catalog defaults", (sourceKind) => {
    const definitions: Partial<InternalMcpCatalog> = {
      localConfig: {
        command: "node",
        environment: [
          {
            key: "INPUT",
            type: "plain_text",
            promptOnInstallation: false,
            value: "${user_config.region}",
          },
          {
            key: "origin",
            type: "plain_text",
            promptOnInstallation: sourceKind === "prompted",
            credentialId:
              sourceKind === "credential" ? "credential" : undefined,
            value: "west",
          },
        ],
      },
      userConfig: {
        region: {
          type: "string",
          title: "Region",
          description: "",
          promptOnInstallation: false,
          default:
            sourceKind === "cycle"
              ? "${user_config.region}"
              : sourceKind === "unknown"
                ? "${user_config.unknown}"
                : "${user_config.origin}",
        },
      },
      oauthConfig:
        sourceKind === "oauth"
          ? {
              name: "Example",
              server_url: "https://example.com",
              client_id: "example",
              redirect_uris: [],
              scopes: [],
              default_scopes: [],
              supports_resource_metadata: false,
              access_token_env_var: "origin",
            }
          : null,
    };
    const source = template({ serviceAccountName: "${env.INPUT}" });
    expect(
      validateDeploymentYaml(source, definitions).errors.join("\n"),
    ).toContain("serviceAccountName");
    expect(() =>
      resolvePlaceholders(
        source,
        { ...context, inputDefinitions: definitions },
        { INPUT: "west" },
      ),
    ).toThrow(/serviceAccountName/);
  });

  test("preserves token-shaped literals and rejects placeholder keys in flow syntax", () => {
    const literal = "ARCHESTRA_TEMPLATE_TOKEN_0_END";
    const source = template({
      containers: [
        {
          name: "mcp-server",
          image: "test:1",
          args: [literal, "${env.INPUT}"],
        },
      ],
    });
    expect(
      resolved(source, literal).spec?.template.spec?.containers[0].args,
    ).toEqual([literal, literal]);
    const keyed = `${template()}extra: { \${env.INPUT}: value }\n`;
    expect(findUnsafeDeploymentYamlPlaceholders(keyed).join("\n")).toContain(
      "Placeholder map keys",
    );
  });

  test("supports flow placeholders without interpreting replacement text as YAML", () => {
    const source = template({
      containers: [
        {
          name: "mcp-server",
          image: "test:1",
          command: "flow-command",
          args: "flow-args",
        },
      ],
    })
      .replace("command: flow-command", "command: [${archestra.command}]")
      .replace(
        "args: flow-args",
        "args: [prefix-${env.INPUT}, '${env.INPUT}']",
      );
    const input = "text, other: value\n${archestra.command}";
    expect(validateDeploymentYaml(source).valid).toBe(true);
    expect(findUnsafeDeploymentYamlPlaceholders(source)).toEqual([]);
    expect(
      resolved(source, input).spec?.template.spec?.containers[0],
    ).toMatchObject({ command: ["node"], args: [`prefix-${input}`, input] });
  });

  test("reports syntax errors from the save-time placeholder check", () => {
    expect(
      findUnsafeDeploymentYamlPlaceholders("invalid: yaml: {{").join("\n"),
    ).toContain("YAML syntax error");
  });

  test.each([
    '"quoted": # comment',
    "true",
    "42",
    "${env.INPUT}",
    "*alias",
    "a\nb",
  ])("preserves an installer value as a string without recursive replacement: %s", (input) => {
    const source = template({
      containers: [
        {
          name: "mcp-server",
          image: "test:1",
          env: [{ name: "INPUT", value: "${env.INPUT}" }],
          args: ["prefix-${env.INPUT}"],
        },
      ],
    });
    const container = resolved(source, input).spec?.template.spec
      ?.containers[0];
    expect(container?.env?.[0].value).toBe(input);
    expect(container?.args).toEqual([`prefix-${input}`]);
  });

  test.each([
    ["serviceAccountName", { serviceAccountName: "${env.INPUT}" }],
    ["serviceAccount", { serviceAccount: "${env.INPUT}" }],
    [
      "secret source",
      { volumes: [{ name: "secret", secret: { secretName: "${env.INPUT}" } }] },
    ],
    [
      "projected token",
      {
        volumes: [
          {
            name: "token",
            projected: {
              sources: [
                {
                  serviceAccountToken: {
                    audience: "${env.INPUT}",
                    path: "token",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
    ["image", { containers: [{ name: "mcp-server", image: "${env.INPUT}" }] }],
    [
      "envFrom",
      {
        containers: [
          {
            name: "mcp-server",
            image: "test:1",
            envFrom: [{ secretRef: { name: "${env.INPUT}" } }],
          },
        ],
      },
    ],
    [
      "secretKeyRef",
      {
        containers: [
          {
            name: "mcp-server",
            image: "test:1",
            env: [
              {
                name: "SECRET",
                valueFrom: {
                  secretKeyRef: { name: "${env.INPUT}", key: "value" },
                },
              },
            ],
          },
        ],
      },
    ],
    ["security context", { securityContext: { runAsUser: "${env.INPUT}" } }],
    [
      "server name as identity",
      { serviceAccountName: "${archestra.server_name}" },
    ],
  ])("rejects installer placeholders in %s during validation and generation", (_label, fields) => {
    const source = template(fields);
    expect(validateDeploymentYaml(source, {}).valid).toBe(false);
    expect(validateDeploymentYaml(source, {}).errors.join("\n")).toContain(
      "spec.template.spec",
    );
    expect(() => resolved(source, "chosen-value")).toThrow(
      /placeholder.*spec\.template\.spec/i,
    );
  });

  test("rejects placeholder map keys and custom admission annotations", () => {
    const metadataCases: k8s.V1ObjectMeta[] = [
      { annotations: { "${env.INPUT}": "value" } },
      { annotations: { "example.com/role": "${archestra.server_name}" } },
    ];
    for (const metadata of metadataCases) {
      const source = yaml.load(template()) as k8s.V1Deployment;
      if (!source.spec) throw new Error("Fixture is missing spec");
      source.spec.template.metadata = metadata;
      expect(validateDeploymentYaml(yaml.dump(source)).valid).toBe(false);
      expect(() => resolved(yaml.dump(source), "chosen")).toThrow(
        /placeholder/i,
      );
    }
  });

  test.each([
    false,
    true,
  ])("preserves a whole arguments placeholder as an array (quoted=%s)", (quoted) => {
    const source = template({
      containers: [
        {
          name: "mcp-server",
          image: "${archestra.docker_image}",
          command: ["${archestra.command}"],
          args: "${archestra.arguments}",
        },
      ],
    });
    const argumentSource = source.replace(
      "args: ${archestra.arguments}",
      quoted
        ? 'args: "${archestra.arguments}"'
        : "args: ${archestra.arguments}",
    );
    const container = resolved(argumentSource, "unused").spec?.template.spec
      ?.containers[0];
    expect(container?.command).toEqual(["node"]);
    expect(container?.args).toEqual(context.arguments);
  });

  test("does not interpret placeholders introduced by trusted context replacement", () => {
    const source = template({
      containers: [
        { name: "mcp-server", image: "test:1", args: ["${archestra.command}"] },
      ],
    });
    const output = yaml.load(
      resolvePlaceholders(
        source,
        { ...context, command: "${env.INPUT}" },
        { INPUT: "replaced" },
      ),
    ) as k8s.V1Deployment;
    expect(output.spec?.template.spec?.containers[0].args).toEqual([
      "${env.INPUT}",
    ]);
  });

  test("allows installer inputs in init-container programs and overwritten name labels", () => {
    const source = yaml.load(
      template({
        initContainers: [
          {
            name: "init",
            image: "test:1",
            command: ["${env.INPUT}"],
            args: ["${archestra.server_name}"],
            env: [{ name: "INPUT", value: "${env.INPUT}" }],
          },
        ],
      }),
    ) as k8s.V1Deployment;
    source.metadata = {
      ...source.metadata,
      labels: { "mcp-server-name": "${archestra.server_name}" },
    };
    if (!source.spec) throw new Error("Fixture is missing spec");
    source.spec.template.metadata = {
      labels: { "mcp-server-name": "${archestra.server_name}" },
    };
    const output = resolved(yaml.dump(source), "input");
    expect(output.spec?.template.spec?.initContainers?.[0]).toMatchObject({
      command: ["input"],
      args: ["example"],
      env: [{ name: "INPUT", value: "input" }],
    });
    expect(output.metadata?.labels?.["mcp-server-name"]).toBe("example");
  });

  test("validates every alias use site instead of trusting its first safe position", () => {
    const source = template({
      containers: [
        {
          name: "mcp-server",
          image: "test:1",
          env: [{ name: "INPUT", value: "${env.INPUT}" }],
        },
      ],
      serviceAccountName: "alias-marker",
    })
      .replace("value: ${env.INPUT}", "value: &input ${env.INPUT}")
      .replace(
        "serviceAccountName: alias-marker",
        "serviceAccountName: *input",
      );
    expect(validateDeploymentYaml(source, {}).errors.join("\n")).toContain(
      "serviceAccountName",
    );
    expect(() => resolved(source, "chosen-account")).toThrow(
      /serviceAccountName/,
    );
  });

  test("rejects recursive YAML aliases with an actionable error", () => {
    const source = template({ recursive: "alias-marker" }).replace(
      "recursive: alias-marker",
      "recursive: &loop\n        self: *loop",
    );
    expect(validateDeploymentYaml(source, {}).errors.join("\n")).toContain(
      "Cyclic YAML aliases",
    );
    expect(() => resolved(source, "unused")).toThrow(/Cyclic YAML aliases/);
  });

  test("bounds expanded aliases while accepting ordinary shared values", () => {
    const levels = Array.from({ length: 16 }, (_, index) =>
      index === 0
        ? "alias0: &alias0 [value, value]"
        : `alias${index}: &alias${index} [*alias${index - 1}, *alias${index - 1}]`,
    );
    const source = `${template()}${levels.join("\n")}\n`;
    expect(validateDeploymentYaml(source, {}).errors.join("\n")).toContain(
      "Deployment YAML exceeds the expansion limit",
    );
    expect(() => resolved(source, "unused")).toThrow(/expansion limit/);

    const ordinary = `${template()}${levels.slice(0, 3).join("\n")}\n`;
    expect(validateDeploymentYaml(ordinary).valid).toBe(true);
    expect(yaml.load(resolvePlaceholders(ordinary, context, {}))).toMatchObject(
      {
        alias1: [
          ["value", "value"],
          ["value", "value"],
        ],
      },
    );
  });

  test("bounds repeated installer text and typed argument expansion", () => {
    const source = template({
      containers: [
        {
          name: "mcp-server",
          image: "test:1",
          args: ["${env.INPUT}".repeat(32)],
        },
      ],
    });
    expect(() => resolved(source, "x".repeat(80_000))).toThrow(
      /expansion limit/,
    );

    const argumentsSource = template({
      containers: [
        {
          name: "mcp-server",
          image: "test:1",
          args: "${archestra.arguments}",
        },
      ],
    });
    expect(() =>
      resolvePlaceholders(
        argumentsSource,
        {
          ...context,
          arguments: Array.from({ length: 32 }, () => "x".repeat(80_000)),
        },
        {},
      ),
    ).toThrow(/expansion limit/);
  });

  test("bounds nesting and empty alias expansion", () => {
    const nested = `${template()}${Array.from({ length: 101 }, (_, index) =>
      index === 0
        ? "depth0: &depth0 [0]"
        : `depth${index}: &depth${index} [*depth${index - 1}]`,
    ).join("\n")}\n`;
    const aliases = Array.from({ length: 16 }, (_, index) =>
      index === 0
        ? "empty0: &empty0 []"
        : `empty${index}: &empty${index} [*empty${index - 1}, *empty${index - 1}]`,
    );
    for (const source of [nested, `${template()}${aliases.join("\n")}\n`]) {
      expect(validateDeploymentYaml(source, {}).errors.join("\n")).toContain(
        "expansion limit",
      );
      expect(() => resolved(source, "unused")).toThrow(/expansion limit/);
    }
  });

  test("bounds diagnostics for repeated invalid placeholders in one long path", () => {
    const source = yaml.load(template()) as k8s.V1Deployment;
    source.metadata = {
      annotations: { ["key".repeat(3_000)]: "${env.INPUT}".repeat(100) },
    };
    const yamlSource = yaml.dump(source);
    const validation = validateDeploymentYaml(yamlSource, {});
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeLessThanOrEqual(21);
    expect(validation.errors.join("\n").length).toBeLessThan(10_000);
    expect(() => resolvePlaceholders(yamlSource, context, {})).toThrow(
      /Too many invalid deployment YAML placeholders/,
    );
  });
});
