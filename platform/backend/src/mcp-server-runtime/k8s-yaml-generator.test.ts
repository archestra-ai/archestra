// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Test file checks for placeholder strings in YAML output

import type { EnvironmentVariableSchema } from "@shared";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  generateDeploymentYamlTemplate,
  mergeLocalConfigIntoYaml,
  validateDeploymentYaml,
} from "./k8s-yaml-generator";

type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

describe("k8s-yaml-generator", () => {
  describe("generateDeploymentYamlTemplate", () => {
    test("generates YAML with plain text env vars", () => {
      const yaml = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment: [
          { key: "API_KEY", type: "plain_text", promptOnInstallation: false },
        ],
      });

      expect(yaml).toContain("name: API_KEY");
      expect(yaml).toContain("value: ${env.API_KEY}");
    });

    test("generates YAML with secret env vars", () => {
      const yaml = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment: [
          { key: "DB_PASSWORD", type: "secret", promptOnInstallation: false },
        ],
      });

      expect(yaml).toContain("name: DB_PASSWORD");
      expect(yaml).toContain("secretKeyRef");
      expect(yaml).toContain("name: ${archestra.secret_name}");
      expect(yaml).toContain("key: DB_PASSWORD");
    });
  });

  describe("mergeLocalConfigIntoYaml", () => {
    const baseYamlWithCustomizations = `# Kubernetes Deployment Spec for MCP Server
apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${archestra.deployment_name}
  labels:
    app: mcp-server
    mcp-server-id: \${archestra.server_id}
    mcp-server-name: \${archestra.server_name}
    custom-label: my-custom-value
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mcp-server
      mcp-server-id: \${archestra.server_id}
  template:
    metadata:
      labels:
        app: mcp-server
        mcp-server-id: \${archestra.server_id}
        mcp-server-name: \${archestra.server_name}
    spec:
      terminationGracePeriodSeconds: 10
      containers:
        - name: mcp-server
          image: \${archestra.docker_image}
          stdin: true
          tty: false
          env:
            - name: EXISTING_VAR
              value: \${env.EXISTING_VAR}
          resources:
            requests:
              memory: 256Mi
              cpu: 100m
            limits:
              memory: 512Mi
              cpu: 500m
      restartPolicy: Always
`;

    test("adds new plain text env var while preserving customizations", () => {
      const environment: EnvironmentVariable[] = [
        {
          key: "EXISTING_VAR",
          type: "plain_text",
          promptOnInstallation: false,
        },
        { key: "NEW_VAR", type: "plain_text", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Should contain both env vars
      expect(result).toContain("name: EXISTING_VAR");
      expect(result).toContain("name: NEW_VAR");
      expect(result).toContain("value: ${env.NEW_VAR}");

      // Should preserve customizations
      expect(result).toContain("custom-label: my-custom-value");
      expect(result).toContain("replicas: 2");
      expect(result).toContain("terminationGracePeriodSeconds: 10");
      expect(result).toContain("memory: 256Mi");
      expect(result).toContain("memory: 512Mi");
    });

    test("adds new secret env var", () => {
      const environment: EnvironmentVariable[] = [
        {
          key: "EXISTING_VAR",
          type: "plain_text",
          promptOnInstallation: false,
        },
        { key: "DB_PASSWORD", type: "secret", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Should contain secret env var with secretKeyRef
      expect(result).toContain("name: DB_PASSWORD");
      expect(result).toContain("secretKeyRef");
      expect(result).toContain("key: DB_PASSWORD");
    });

    test("adds mounted secret file to volumes", () => {
      const environment: EnvironmentVariable[] = [
        {
          key: "EXISTING_VAR",
          type: "plain_text",
          promptOnInstallation: false,
        },
        {
          key: "CERT_FILE",
          type: "secret",
          promptOnInstallation: false,
          mounted: true,
        },
      ];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Should contain volume mount for the secret file
      expect(result).toContain("mountPath: /secrets/CERT_FILE");
      expect(result).toContain("name: mounted-secrets");
      expect(result).toContain("readOnly: true");

      // Should contain volume definition
      expect(result).toContain("volumes:");
      expect(result).toContain("secretName: ${archestra.secret_name}");
    });

    test("preserves env vars in YAML that are not in localConfig", () => {
      const environment: EnvironmentVariable[] = [
        // Only NEW_VAR is in localConfig, EXISTING_VAR is not
        { key: "NEW_VAR", type: "plain_text", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Should preserve EXISTING_VAR from the original YAML (not managed by localConfig)
      expect(result).toContain("name: EXISTING_VAR");

      // Should contain the new env var from localConfig
      expect(result).toContain("name: NEW_VAR");

      // Should preserve customizations
      expect(result).toContain("custom-label: my-custom-value");
    });

    test("handles empty environment array by preserving existing env vars", () => {
      const environment: EnvironmentVariable[] = [];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Should preserve EXISTING_VAR from the original YAML
      expect(result).toContain("custom-label: my-custom-value");
      expect(result).toContain("name: EXISTING_VAR");
    });

    test("handles YAML without existing env section", () => {
      const yamlWithoutEnv = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${archestra.deployment_name}
  labels:
    app: mcp-server
    custom-label: preserved
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-server
  template:
    metadata:
      labels:
        app: mcp-server
    spec:
      containers:
        - name: mcp-server
          image: \${archestra.docker_image}
          resources:
            requests:
              memory: 128Mi
      restartPolicy: Always
`;

      const environment: EnvironmentVariable[] = [
        { key: "NEW_VAR", type: "plain_text", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(yamlWithoutEnv, environment);

      // Should add env section
      expect(result).toContain("name: NEW_VAR");
      expect(result).toContain("value: ${env.NEW_VAR}");

      // Should preserve customizations
      expect(result).toContain("custom-label: preserved");
    });

    test("preserves comments in YAML", () => {
      const yamlWithComments = `# This is a custom comment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${archestra.deployment_name}
  labels:
    app: mcp-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-server
  template:
    spec:
      containers:
        - name: mcp-server
          image: \${archestra.docker_image}
          env:
            - name: OLD_VAR
              value: \${env.OLD_VAR}
      restartPolicy: Always
`;

      const environment: EnvironmentVariable[] = [
        { key: "NEW_VAR", type: "plain_text", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(yamlWithComments, environment);

      // Comments at the top should be preserved
      expect(result).toContain("# This is a custom comment");
    });

    test("handles mixed env types correctly", () => {
      const environment: EnvironmentVariable[] = [
        { key: "PLAIN_VAR", type: "plain_text", promptOnInstallation: false },
        { key: "SECRET_VAR", type: "secret", promptOnInstallation: false },
        {
          key: "MOUNTED_SECRET",
          type: "secret",
          promptOnInstallation: false,
          mounted: true,
        },
        { key: "BOOL_VAR", type: "boolean", promptOnInstallation: false },
        { key: "NUM_VAR", type: "number", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Plain text vars use ${env.KEY}
      expect(result).toContain("name: PLAIN_VAR");
      expect(result).toContain("value: ${env.PLAIN_VAR}");

      // Boolean and number are treated as plain text
      expect(result).toContain("name: BOOL_VAR");
      expect(result).toContain("value: ${env.BOOL_VAR}");
      expect(result).toContain("name: NUM_VAR");
      expect(result).toContain("value: ${env.NUM_VAR}");

      // Secret vars use secretKeyRef
      expect(result).toContain("name: SECRET_VAR");
      expect(result).toContain("key: SECRET_VAR");

      // Mounted secrets have volume mounts
      expect(result).toContain("mountPath: /secrets/MOUNTED_SECRET");
    });

    test("updates existing env var type from plain to secret", () => {
      const environment: EnvironmentVariable[] = [
        // EXISTING_VAR was plain_text, now it's a secret
        { key: "EXISTING_VAR", type: "secret", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(
        baseYamlWithCustomizations,
        environment,
      );

      // Should now use secretKeyRef instead of value
      expect(result).toContain("name: EXISTING_VAR");
      expect(result).toContain("secretKeyRef");
      expect(result).not.toContain("value: ${env.EXISTING_VAR}");
    });

    test("removes env vars that were previously managed but are now deleted", () => {
      // YAML has two env vars: EXISTING_VAR and CUSTOM_VAR
      const yamlWithTwoEnvVars = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${archestra.deployment_name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-server
  template:
    metadata:
      labels:
        app: mcp-server
    spec:
      containers:
        - name: mcp-server
          image: \${archestra.docker_image}
          env:
            - name: EXISTING_VAR
              value: \${env.EXISTING_VAR}
            - name: CUSTOM_VAR
              value: custom-value
      restartPolicy: Always
`;

      // New environment only has EXISTING_VAR (CUSTOM_VAR was removed from localConfig)
      const newEnvironment: EnvironmentVariable[] = [
        {
          key: "EXISTING_VAR",
          type: "plain_text",
          promptOnInstallation: false,
        },
      ];

      // Previously, both EXISTING_VAR and CUSTOM_VAR were managed by localConfig
      const previouslyManagedKeys = new Set(["EXISTING_VAR", "CUSTOM_VAR"]);

      const result = mergeLocalConfigIntoYaml(
        yamlWithTwoEnvVars,
        newEnvironment,
        previouslyManagedKeys,
      );

      // EXISTING_VAR should still be present
      expect(result).toContain("name: EXISTING_VAR");

      // CUSTOM_VAR should be removed because it was previously managed but now deleted
      expect(result).not.toContain("CUSTOM_VAR");
    });

    test("preserves user-added env vars that were never managed by localConfig", () => {
      // YAML has EXISTING_VAR (managed) and USER_ADDED_VAR (never managed)
      const yamlWithUserAddedEnv = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${archestra.deployment_name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mcp-server
  template:
    metadata:
      labels:
        app: mcp-server
    spec:
      containers:
        - name: mcp-server
          image: \${archestra.docker_image}
          env:
            - name: EXISTING_VAR
              value: \${env.EXISTING_VAR}
            - name: USER_ADDED_VAR
              value: user-custom-value
      restartPolicy: Always
`;

      // New environment only has EXISTING_VAR
      const newEnvironment: EnvironmentVariable[] = [
        {
          key: "EXISTING_VAR",
          type: "plain_text",
          promptOnInstallation: false,
        },
      ];

      // Previously, only EXISTING_VAR was managed (USER_ADDED_VAR was added by user in YAML)
      const previouslyManagedKeys = new Set(["EXISTING_VAR"]);

      const result = mergeLocalConfigIntoYaml(
        yamlWithUserAddedEnv,
        newEnvironment,
        previouslyManagedKeys,
      );

      // EXISTING_VAR should still be present
      expect(result).toContain("name: EXISTING_VAR");

      // USER_ADDED_VAR should be preserved because it was never managed by localConfig
      expect(result).toContain("name: USER_ADDED_VAR");
      expect(result).toContain("value: user-custom-value");
    });

    test("returns original YAML if parsing fails", () => {
      const invalidYaml = "this is not: valid: yaml: {{{}}}";
      const environment: EnvironmentVariable[] = [
        { key: "NEW_VAR", type: "plain_text", promptOnInstallation: false },
      ];

      const result = mergeLocalConfigIntoYaml(invalidYaml, environment);

      // Should return original YAML unchanged
      expect(result).toBe(invalidYaml);
    });
  });

  describe("validateDeploymentYaml", () => {
    test("validates correct YAML", () => {
      const yaml = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment: [],
      });

      const result = validateDeploymentYaml(yaml);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("returns error for invalid YAML syntax", () => {
      const result = validateDeploymentYaml("invalid: yaml: {{");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
