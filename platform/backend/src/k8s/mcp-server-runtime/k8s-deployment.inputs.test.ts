// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Tests catalog placeholder interpolation.

import type * as k8s from "@kubernetes/client-node";
import { describe, expect, test } from "vitest";
import type { InternalMcpCatalog, McpServer } from "@/types";
import K8sDeployment from "./k8s-deployment";

function deployment({
  catalog,
  environmentValues,
  userConfigValues,
}: {
  catalog: Partial<InternalMcpCatalog> | null;
  environmentValues?: Record<string, string>;
  userConfigValues?: Record<string, string>;
}) {
  return new K8sDeployment({
    mcpServer: { id: "input-test", name: "input-test" } as McpServer,
    catalogItem: catalog as InternalMcpCatalog | null,
    namespace: "test",
    k8sApi: {} as k8s.CoreV1Api,
    k8sAppsApi: {} as k8s.AppsV1Api,
    k8sNetworkingApi: {} as k8s.NetworkingV1Api,
    k8sAttach: {} as k8s.Attach,
    k8sLog: {} as k8s.Log,
    k8sExec: {} as k8s.Exec,
    environmentValues,
    userConfigValues,
  });
}

describe("catalog installation input boundary", () => {
  test("resolves fixed catalog fields in custom YAML with flow commands", () => {
    const localConfig = {
      command: "node",
      environment: [
        {
          key: "ACCOUNT",
          type: "plain_text" as const,
          promptOnInstallation: false,
          value: "${user_config.account}",
        },
        {
          key: "IMAGE",
          type: "plain_text" as const,
          promptOnInstallation: false,
          value: "example/server:2",
        },
      ],
    };
    const instance = deployment({
      catalog: {
        localConfig,
        userConfig: {
          account: {
            type: "string",
            title: "Account",
            description: "",
            promptOnInstallation: false,
            default: "catalog-account",
          },
        },
        deploymentSpecYaml:
          "apiVersion: apps/v1\nkind: Deployment\nmetadata: {}\nspec:\n  template:\n    spec:\n      serviceAccountName: ${env.ACCOUNT}\n      containers:\n        - name: server\n          image: ${env.IMAGE}\n          command: [${archestra.command}]\n",
      },
      environmentValues: {
        ACCOUNT: "installation-account",
        IMAGE: "example/other:1",
        account: "installation-default",
      },
      userConfigValues: { account: "installation-default" },
    });
    const pod = instance.generateDeploymentSpec(
      "example/server:1",
      localConfig,
      false,
      8080,
    ).spec?.template.spec;
    expect(pod?.serviceAccountName).toBe("catalog-account");
    expect(pod?.containers[0]).toMatchObject({
      image: "example/server:2",
      command: ["node"],
    });
    expect(pod?.containers[0].env).toContainEqual({
      name: "ACCOUNT",
      value: "catalog-account",
    });
  });

  test("rejects prompted defaults in custom YAML deployment fields", () => {
    const localConfig = {
      command: "node",
      environment: [
        {
          key: "ACCOUNT",
          type: "plain_text" as const,
          promptOnInstallation: false,
          value: "${user_config.account}",
        },
      ],
    };
    const instance = deployment({
      catalog: {
        localConfig,
        userConfig: {
          account: {
            type: "string",
            title: "Account",
            description: "",
            promptOnInstallation: true,
            default: "catalog-account",
          },
        },
        deploymentSpecYaml:
          "apiVersion: apps/v1\nkind: Deployment\nmetadata: {}\nspec:\n  template:\n    spec:\n      serviceAccountName: ${env.ACCOUNT}\n      containers:\n        - name: server\n          image: example/server:1\n",
      },
      userConfigValues: { account: "installation-account" },
    });
    expect(() =>
      instance.generateDeploymentSpec(
        "example/server:1",
        localConfig,
        false,
        8080,
      ),
    ).toThrow(/serviceAccountName/);
  });

  test("does not invent environment variables when a catalog declares no inputs", () => {
    const instance = deployment({
      catalog: {
        localConfig: { command: "node", serviceAccount: "approved-reader" },
      },
      environmentValues: { UNDECLARED_ENV: "sentinel" },
      userConfigValues: { undeclared_config: "sentinel", toString: "sentinel" },
    });
    expect(instance.createContainerEnvFromConfig().envVars).toEqual([]);
  });

  test("keeps declared prompted inputs and catalog static defaults", () => {
    const instance = deployment({
      catalog: {
        localConfig: {
          command: "node",
          environment: [
            {
              key: "PROMPTED_ENV",
              type: "plain_text",
              promptOnInstallation: true,
            },
            {
              key: "FIXED_ENV",
              type: "plain_text",
              promptOnInstallation: false,
              value: "catalog-env",
            },
          ],
        },
        userConfig: {
          input: {
            type: "string",
            title: "Input",
            description: "Input",
            promptOnInstallation: true,
          },
          fixed: {
            type: "string",
            title: "Fixed",
            description: "Fixed",
            promptOnInstallation: false,
            default: "catalog-config",
          },
        },
      },
      environmentValues: {
        PROMPTED_ENV: "input-env",
        FIXED_ENV: "override",
        EXTRA: "sentinel",
      },
      userConfigValues: {
        input: "input-config",
        fixed: "override",
        extra: "sentinel",
      },
    });
    expect(instance.createContainerEnvFromConfig().envVars).toEqual([
      { name: "PROMPTED_ENV", value: "input-env" },
      { name: "FIXED_ENV", value: "catalog-env" },
      { name: "INPUT", value: "input-config" },
      { name: "FIXED", value: "catalog-config" },
    ]);
  });

  test("preserves the catalog-declared OAuth token environment variable", () => {
    const instance = deployment({
      catalog: {
        localConfig: { command: "node" },
        oauthConfig: {
          name: "Synthetic OAuth",
          server_url: "https://example.test",
          client_id: "test-client",
          redirect_uris: [],
          scopes: [],
          default_scopes: [],
          supports_resource_metadata: false,
          access_token_env_var: "UPSTREAM_TOKEN",
        },
      },
      environmentValues: {
        UPSTREAM_TOKEN: "synthetic-token",
        UNDECLARED: "sentinel",
      },
    });
    expect(instance.createContainerEnvFromConfig().envVars).toEqual([
      { name: "UPSTREAM_TOKEN", value: "synthetic-token" },
    ]);
  });

  test("preserves direct runtime callers without a catalog", () => {
    const instance = deployment({
      catalog: null,
      environmentValues: { DIRECT: "value" },
      userConfigValues: { setting: "value" },
    });
    expect(instance.createContainerEnvFromConfig().envVars).toEqual([
      { name: "DIRECT", value: "value" },
      { name: "SETTING", value: "value" },
    ]);
  });

  test.each([
    false,
    true,
  ])("uses static user config for every interpolation path (custom YAML: %s)", (customYaml) => {
    const localConfig = {
      command: "sh",
      arguments: [
        "-c",
        "${user_config.script}",
        "${user_config.legacy}",
        "${user_config.unknown}",
      ],
      environment: [
        {
          key: "STATIC_SCRIPT",
          type: "plain_text" as const,
          promptOnInstallation: false,
          value: "${user_config.script}",
        },
      ],
    };
    const instance = deployment({
      catalog: {
        localConfig,
        userConfig: {
          script: {
            type: "string",
            title: "Script",
            description: "Script",
            promptOnInstallation: false,
            default: "printf approved",
          },
          legacy: { type: "string", title: "Input", description: "Input" },
        },
        deploymentSpecYaml: customYaml
          ? "apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - name: server\n          image: example/server:1\n          env:\n            - name: YAML_SCRIPT\n              value: ${env.STATIC_SCRIPT}\n"
          : null,
      },
      environmentValues: {
        script: "unreviewed script",
        legacy: "legacy-input",
        unknown: "undeclared-input",
      },
      userConfigValues: { script: "another unreviewed script" },
    });
    const container = instance.generateDeploymentSpec(
      "example/server:1",
      localConfig,
      false,
      8080,
    ).spec?.template.spec?.containers[0];
    expect(container?.args).toEqual([
      "-c",
      "printf approved",
      "legacy-input",
      "${user_config.unknown}",
    ]);
    expect(container?.env).toContainEqual({
      name: "STATIC_SCRIPT",
      value: "printf approved",
    });
    if (customYaml)
      expect(container?.env).toContainEqual({
        name: "YAML_SCRIPT",
        value: "printf approved",
      });
  });
});
