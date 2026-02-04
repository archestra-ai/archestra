import {
  generateDeploymentYamlTemplate,
  mergeLocalConfigIntoYaml,
} from "@/mcp-server-runtime/k8s-yaml-generator";
import { InternalMcpCatalogModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("Internal MCP Catalog - Environment Variables", () => {
  // =========================================================================
  // 1. CREATE - Environment Variable Handling
  // =========================================================================
  describe("CREATE - Environment Variable Handling", () => {
    test("1.1 creates catalog with plain_text env vars", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-plain-text-env",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "LOG_LEVEL",
              type: "plain_text",
              promptOnInstallation: false,
              value: "debug",
            },
            {
              key: "APP_NAME",
              type: "plain_text",
              promptOnInstallation: false,
              value: "test-app",
            },
          ],
        },
      });

      expect(catalog.localConfig?.environment).toHaveLength(2);
      expect(catalog.localConfig?.environment?.[0]).toMatchObject({
        key: "LOG_LEVEL",
        type: "plain_text",
        value: "debug",
      });
      expect(catalog.localConfig?.environment?.[1]).toMatchObject({
        key: "APP_NAME",
        type: "plain_text",
        value: "test-app",
      });
    });

    test("1.2 creates catalog with secret env vars (not prompted) - stores in secrets manager", async ({
      makeSecret,
    }) => {
      // Create a secret to simulate what the route does
      const envSecret = await makeSecret({
        name: "env-secret",
        secret: {
          API_KEY: "secret-api-key-123",
          DB_PASSWORD: "secret-db-pass-456",
        },
      });

      const catalog = await InternalMcpCatalogModel.create({
        name: "test-secret-env",
        serverType: "local",
        localConfigSecretId: envSecret.id,
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
              // Note: value is NOT stored in localConfig for non-prompted secrets
              // It's stored in the secrets table and referenced via localConfigSecretId
            },
            {
              key: "DB_PASSWORD",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      });

      expect(catalog.localConfigSecretId).toBe(envSecret.id);
      expect(catalog.localConfig?.environment).toHaveLength(2);
      expect(catalog.localConfig?.environment?.[0]).toMatchObject({
        key: "API_KEY",
        type: "secret",
        promptOnInstallation: false,
      });
      // Values should NOT be in localConfig (they're in secrets table)
      expect(catalog.localConfig?.environment?.[0].value).toBeUndefined();
    });

    test("1.3 creates catalog with prompted secret env vars", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-prompted-secret",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "USER_API_KEY",
              type: "secret",
              promptOnInstallation: true,
              required: true,
              description: "Your API key",
            },
          ],
        },
      });

      // No secret created yet (user provides during install)
      expect(catalog.localConfigSecretId).toBeNull();
      expect(catalog.localConfig?.environment?.[0]).toMatchObject({
        key: "USER_API_KEY",
        type: "secret",
        promptOnInstallation: true,
        required: true,
      });
    });

    test("1.4 creates catalog with deploymentSpecYaml - env vars merged into YAML", async () => {
      const environment = [
        {
          key: "LOG_LEVEL",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
        {
          key: "API_KEY",
          type: "secret" as const,
          promptOnInstallation: false,
        },
      ];

      // Generate initial YAML template
      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment,
      });

      const catalog = await InternalMcpCatalogModel.create({
        name: "test-yaml-env",
        serverType: "local",
        deploymentSpecYaml: yamlTemplate,
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment,
        },
      });

      // YAML should contain env placeholders
      expect(catalog.deploymentSpecYaml).toContain("name: LOG_LEVEL");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(catalog.deploymentSpecYaml).toContain("value: ${env.LOG_LEVEL}");
      expect(catalog.deploymentSpecYaml).toContain("name: API_KEY");
      expect(catalog.deploymentSpecYaml).toContain("secretKeyRef");
    });

    test("1.5 creates catalog with mounted secret", async () => {
      const environment = [
        {
          key: "SERVICE_ACCOUNT_JSON",
          type: "secret" as const,
          promptOnInstallation: false,
          mounted: true,
        },
      ];

      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment,
      });

      // Merge with mounted secret handling
      const mergedYaml = mergeLocalConfigIntoYaml(yamlTemplate, environment);

      expect(mergedYaml).toContain("volumeMounts");
      expect(mergedYaml).toContain("mountPath: /secrets/SERVICE_ACCOUNT_JSON");
      expect(mergedYaml).toContain("mounted-secrets");
    });
  });

  // =========================================================================
  // 2. UPDATE - Environment Variable Handling
  // =========================================================================
  describe("UPDATE - Environment Variable Handling", () => {
    test("2.1 adds new plain_text env var to existing catalog", async () => {
      // Create catalog with one env var
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-add-env",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "EXISTING_VAR",
              type: "plain_text",
              promptOnInstallation: false,
              value: "existing",
            },
          ],
        },
      });

      // Update to add a new env var
      const updated = await InternalMcpCatalogModel.update(catalog.id, {
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "EXISTING_VAR",
              type: "plain_text",
              promptOnInstallation: false,
              value: "existing",
            },
            {
              key: "NEW_VAR",
              type: "plain_text",
              promptOnInstallation: false,
              value: "new-value",
            },
          ],
        },
      });

      expect(updated?.localConfig?.environment).toHaveLength(2);
      expect(updated?.localConfig?.environment?.[1]).toMatchObject({
        key: "NEW_VAR",
        type: "plain_text",
        value: "new-value",
      });
    });

    test("2.2 adds new secret env var to existing catalog", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-add-secret-env",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "EXISTING_VAR",
              type: "plain_text",
              promptOnInstallation: false,
              value: "existing",
            },
          ],
        },
      });

      const updated = await InternalMcpCatalogModel.update(catalog.id, {
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [
            {
              key: "EXISTING_VAR",
              type: "plain_text",
              promptOnInstallation: false,
              value: "existing",
            },
            {
              key: "NEW_SECRET",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      });

      expect(updated?.localConfig?.environment).toHaveLength(2);
      expect(updated?.localConfig?.environment?.[1]).toMatchObject({
        key: "NEW_SECRET",
        type: "secret",
        promptOnInstallation: true,
      });
    });

    test("2.3 removes env var from localConfig - YAML updated correctly", async () => {
      // Create catalog with two env vars and YAML
      const environment = [
        {
          key: "KEEP_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
        {
          key: "REMOVE_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment,
      });

      const catalog = await InternalMcpCatalogModel.create({
        name: "test-remove-env",
        serverType: "local",
        deploymentSpecYaml: yamlTemplate,
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment,
        },
      });

      // Verify both env vars are in YAML
      expect(catalog.deploymentSpecYaml).toContain("name: KEEP_VAR");
      expect(catalog.deploymentSpecYaml).toContain("name: REMOVE_VAR");

      // Now remove REMOVE_VAR from localConfig
      const newEnvironment = [
        {
          key: "KEEP_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      // Build previouslyManagedKeys from original environment
      const previouslyManagedKeys = new Set(environment.map((e) => e.key));

      // Merge with previouslyManagedKeys to remove REMOVE_VAR
      expect(catalog.deploymentSpecYaml).toBeDefined();
      const updatedYaml = mergeLocalConfigIntoYaml(
        catalog.deploymentSpecYaml as string,
        newEnvironment,
        previouslyManagedKeys,
      );

      // KEEP_VAR should still be present
      expect(updatedYaml).toContain("name: KEEP_VAR");
      // REMOVE_VAR should be removed
      expect(updatedYaml).not.toContain("REMOVE_VAR");
    });

    test("2.4 removes all env vars - YAML env section removed", async () => {
      const environment = [
        {
          key: "VAR1",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
        {
          key: "VAR2",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment,
      });

      // Verify env vars are present
      expect(yamlTemplate).toContain("name: VAR1");
      expect(yamlTemplate).toContain("name: VAR2");

      // Remove all env vars
      const previouslyManagedKeys = new Set(environment.map((e) => e.key));
      const updatedYaml = mergeLocalConfigIntoYaml(
        yamlTemplate,
        [], // Empty environment
        previouslyManagedKeys,
      );

      // Neither env var should be present
      expect(updatedYaml).not.toContain("VAR1");
      expect(updatedYaml).not.toContain("VAR2");
    });

    test("2.5 changes env var type from plain_text to secret", async () => {
      const originalEnv = [
        {
          key: "CONVERTABLE_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment: originalEnv,
      });

      // Verify it's a plain text env var
      expect(yamlTemplate).toContain("name: CONVERTABLE_VAR");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(yamlTemplate).toContain("value: ${env.CONVERTABLE_VAR}");
      expect(yamlTemplate).not.toContain("secretKeyRef");

      // Change type to secret
      const newEnv = [
        {
          key: "CONVERTABLE_VAR",
          type: "secret" as const,
          promptOnInstallation: false,
        },
      ];

      const previouslyManagedKeys = new Set(originalEnv.map((e) => e.key));
      const updatedYaml = mergeLocalConfigIntoYaml(
        yamlTemplate,
        newEnv,
        previouslyManagedKeys,
      );

      // Should now use secretKeyRef
      expect(updatedYaml).toContain("name: CONVERTABLE_VAR");
      expect(updatedYaml).toContain("secretKeyRef");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(updatedYaml).not.toContain("value: ${env.CONVERTABLE_VAR}");
    });

    test("2.6 changes env var type from secret to plain_text", async () => {
      const originalEnv = [
        {
          key: "CONVERTABLE_VAR",
          type: "secret" as const,
          promptOnInstallation: false,
        },
      ];

      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment: originalEnv,
      });

      // Verify it's a secret env var
      expect(yamlTemplate).toContain("name: CONVERTABLE_VAR");
      expect(yamlTemplate).toContain("secretKeyRef");

      // Change type to plain_text
      const newEnv = [
        {
          key: "CONVERTABLE_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      const previouslyManagedKeys = new Set(originalEnv.map((e) => e.key));
      const updatedYaml = mergeLocalConfigIntoYaml(
        yamlTemplate,
        newEnv,
        previouslyManagedKeys,
      );

      // Should now use plain value
      expect(updatedYaml).toContain("name: CONVERTABLE_VAR");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(updatedYaml).toContain("value: ${env.CONVERTABLE_VAR}");
      expect(updatedYaml).not.toContain("secretKeyRef");
    });
  });

  // =========================================================================
  // 3. YAML Synchronization
  // =========================================================================
  describe("YAML Synchronization", () => {
    test("3.1 preserves user-added YAML env vars not in localConfig", async () => {
      // YAML with a user-added custom env var
      const yamlWithCustomEnv = `apiVersion: apps/v1
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
            - name: MANAGED_VAR
              value: \${env.MANAGED_VAR}
            - name: USER_CUSTOM_VAR
              value: my-custom-value
      restartPolicy: Always
`;

      // localConfig only knows about MANAGED_VAR
      const environment = [
        {
          key: "MANAGED_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      // Previously managed keys only includes MANAGED_VAR
      const previouslyManagedKeys = new Set(["MANAGED_VAR"]);

      const updatedYaml = mergeLocalConfigIntoYaml(
        yamlWithCustomEnv,
        environment,
        previouslyManagedKeys,
      );

      // MANAGED_VAR should still be present
      expect(updatedYaml).toContain("name: MANAGED_VAR");
      // USER_CUSTOM_VAR should be preserved (it was never managed)
      expect(updatedYaml).toContain("name: USER_CUSTOM_VAR");
      expect(updatedYaml).toContain("value: my-custom-value");
    });

    test("3.2 removes previously managed env var from YAML when deleted from localConfig", async () => {
      // YAML with two managed env vars
      const yamlWithManagedEnvs = `apiVersion: apps/v1
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
            - name: KEEP_VAR
              value: \${env.KEEP_VAR}
            - name: DELETE_VAR
              value: \${env.DELETE_VAR}
      restartPolicy: Always
`;

      // New environment only has KEEP_VAR
      const newEnvironment = [
        {
          key: "KEEP_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      // Both were previously managed
      const previouslyManagedKeys = new Set(["KEEP_VAR", "DELETE_VAR"]);

      const updatedYaml = mergeLocalConfigIntoYaml(
        yamlWithManagedEnvs,
        newEnvironment,
        previouslyManagedKeys,
      );

      // KEEP_VAR should still be present
      expect(updatedYaml).toContain("name: KEEP_VAR");
      // DELETE_VAR should be removed (it was managed but now deleted)
      expect(updatedYaml).not.toContain("DELETE_VAR");
    });

    test("3.3 adds env section to YAML that has no env vars", async () => {
      const yamlWithoutEnv = `apiVersion: apps/v1
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
      restartPolicy: Always
`;

      const newEnvironment = [
        {
          key: "NEW_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      const updatedYaml = mergeLocalConfigIntoYaml(
        yamlWithoutEnv,
        newEnvironment,
        new Set(), // No previously managed keys
      );

      // Should now have env section
      expect(updatedYaml).toContain("name: NEW_VAR");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(updatedYaml).toContain("value: ${env.NEW_VAR}");
    });

    test("3.4 correctly distinguishes user-added vs previously-managed env vars", async () => {
      // Scenario:
      // - MANAGED_VAR: was managed, still managed
      // - DELETED_MANAGED_VAR: was managed, now deleted
      // - USER_CUSTOM_VAR: was never managed, should be preserved

      const yaml = `apiVersion: apps/v1
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
            - name: MANAGED_VAR
              value: \${env.MANAGED_VAR}
            - name: DELETED_MANAGED_VAR
              value: \${env.DELETED_MANAGED_VAR}
            - name: USER_CUSTOM_VAR
              value: custom-user-value
      restartPolicy: Always
`;

      // New environment only has MANAGED_VAR (DELETED_MANAGED_VAR removed)
      const newEnvironment = [
        {
          key: "MANAGED_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
      ];

      // Previously, both MANAGED_VAR and DELETED_MANAGED_VAR were managed
      // USER_CUSTOM_VAR was never in localConfig.environment
      const previouslyManagedKeys = new Set([
        "MANAGED_VAR",
        "DELETED_MANAGED_VAR",
      ]);

      const updatedYaml = mergeLocalConfigIntoYaml(
        yaml,
        newEnvironment,
        previouslyManagedKeys,
      );

      // MANAGED_VAR: still present (still managed)
      expect(updatedYaml).toContain("name: MANAGED_VAR");

      // DELETED_MANAGED_VAR: should be removed (was managed, now deleted)
      expect(updatedYaml).not.toContain("DELETED_MANAGED_VAR");

      // USER_CUSTOM_VAR: should be preserved (was never managed)
      expect(updatedYaml).toContain("name: USER_CUSTOM_VAR");
      expect(updatedYaml).toContain("value: custom-user-value");
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================
  describe("Edge Cases", () => {
    test("handles empty environment array", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-empty-env",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          environment: [],
        },
      });

      expect(catalog.localConfig?.environment).toEqual([]);
    });

    test("handles undefined environment", async () => {
      const catalog = await InternalMcpCatalogModel.create({
        name: "test-undefined-env",
        serverType: "local",
        localConfig: {
          command: "npx",
          arguments: ["-y", "@test/server"],
          // No environment field
        },
      });

      expect(catalog.localConfig?.environment).toBeUndefined();
    });

    test("handles mixed env types correctly", async () => {
      const environment = [
        {
          key: "PLAIN_VAR",
          type: "plain_text" as const,
          promptOnInstallation: false,
        },
        {
          key: "SECRET_VAR",
          type: "secret" as const,
          promptOnInstallation: false,
        },
        {
          key: "BOOL_VAR",
          type: "boolean" as const,
          promptOnInstallation: false,
        },
        {
          key: "NUM_VAR",
          type: "number" as const,
          promptOnInstallation: false,
        },
        {
          key: "MOUNTED_SECRET",
          type: "secret" as const,
          promptOnInstallation: false,
          mounted: true,
        },
      ];

      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "test-id",
        serverName: "test-server",
        namespace: "default",
        dockerImage: "test-image:latest",
        environment,
      });

      // Plain text types use ${env.KEY}
      expect(yamlTemplate).toContain("name: PLAIN_VAR");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(yamlTemplate).toContain("value: ${env.PLAIN_VAR}");

      // Boolean and number are treated as plain text
      expect(yamlTemplate).toContain("name: BOOL_VAR");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(yamlTemplate).toContain("value: ${env.BOOL_VAR}");
      expect(yamlTemplate).toContain("name: NUM_VAR");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Testing YAML placeholders
      expect(yamlTemplate).toContain("value: ${env.NUM_VAR}");

      // Secret uses secretKeyRef
      expect(yamlTemplate).toContain("name: SECRET_VAR");

      // Mounted secret should NOT be in env (it's a volume mount)
      // Note: generateDeploymentYamlTemplate adds all secrets to env,
      // but mergeLocalConfigIntoYaml handles mounted secrets correctly
      const mergedYaml = mergeLocalConfigIntoYaml(yamlTemplate, environment);
      expect(mergedYaml).toContain("mountPath: /secrets/MOUNTED_SECRET");
    });
  });
});
