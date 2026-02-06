import type * as k8s from "@kubernetes/client-node";
import {
  type EnvironmentVariableSchema,
  MCP_ORCHESTRATOR_DEFAULTS,
} from "@shared";
import * as yaml from "js-yaml";
import type { z } from "zod";

// Helper to create placeholder strings without triggering noTemplateCurlyInString lint rule
const placeholder = (type: string, key: string) => `\${${type}.${key}}`;

/**
 * Context for generating deployment YAML template.
 */
export interface DeploymentYamlContext {
  serverId: string;
  serverName: string;
  namespace: string;
  dockerImage: string;
  command?: string;
  arguments?: string[];
  environment?: z.infer<typeof EnvironmentVariableSchema>[];
  serviceAccount?: string;
  /** Transport type: "stdio" (default) or "streamable-http" */
  transportType?: "stdio" | "streamable-http";
  /** HTTP port for streamable-http transport (default: 8080) */
  httpPort?: number;
}

/**
 * Validation result for deployment YAML.
 */
export interface YamlValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Placeholder patterns used in the YAML template.
 * - ${env.KEY} for plain text environment variables
 * - ${secret.KEY} for secret-type environment variables
 * - ${archestra.*} for system-managed values
 */
const PLACEHOLDER_PATTERNS = {
  env: /\$\{env\.([^}]+)\}/g,
  secret: /\$\{secret\.([^}]+)\}/g,
  archestra: /\$\{archestra\.([^}]+)\}/g,
};

/**
 * System-managed archestra placeholders.
 */
const ARCHESTRA_PLACEHOLDERS = [
  "deployment_name",
  "server_id",
  "server_name",
  "namespace",
  "docker_image",
  "secret_name",
  "command",
  "arguments",
  "service_account",
] as const;

/**
 * Protected fields that cannot be modified by user YAML.
 * These are always overwritten at deployment time.
 */
/**
 * Generates a deployment YAML template with placeholders for environment variables.
 *
 * @param context - The context for generating the template
 * @returns YAML string with placeholders
 */
export function generateDeploymentYamlTemplate(
  context: DeploymentYamlContext,
): string {
  const {
    environment = [],
    transportType = "stdio",
    httpPort = 8080,
  } = context;
  const needsHttp = transportType === "streamable-http";

  // Build environment variables section
  const envSection: Array<{
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string } };
  }> = [];

  for (const envVar of environment) {
    if (envVar.type === "secret") {
      // Secret type: use secretKeyRef
      envSection.push({
        name: envVar.key,
        valueFrom: {
          secretKeyRef: {
            name: placeholder("archestra", "secret_name"),
            key: envVar.key,
          },
        },
      });
    } else {
      // Plain text, boolean, number: use placeholder
      envSection.push({
        name: envVar.key,
        value: placeholder("env", envVar.key),
      });
    }
  }

  // Build container spec based on transport type
  const containerSpec: Record<string, unknown> = {
    name: "mcp-server",
    image: placeholder("archestra", "docker_image"),
    // command and args come from basic config
    ...(envSection.length > 0 ? { env: envSection } : {}),
    resources: {
      requests: {
        memory: MCP_ORCHESTRATOR_DEFAULTS.resourceRequestMemory,
        cpu: MCP_ORCHESTRATOR_DEFAULTS.resourceRequestCpu,
      },
    },
  };

  if (needsHttp) {
    // HTTP transport: expose port
    containerSpec.ports = [
      {
        containerPort: httpPort,
        protocol: "TCP",
      },
    ];
  } else {
    // Stdio transport: enable stdin for JSON-RPC communication
    containerSpec.stdin = true;
    containerSpec.tty = false;
  }

  // Build the deployment spec structure
  const deploymentSpec = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: placeholder("archestra", "deployment_name"),
      labels: {
        app: "mcp-server",
        "mcp-server-id": placeholder("archestra", "server_id"),
        "mcp-server-name": placeholder("archestra", "server_name"),
      },
    },
    spec: {
      replicas: MCP_ORCHESTRATOR_DEFAULTS.replicas,
      selector: {
        matchLabels: {
          app: "mcp-server",
          "mcp-server-id": placeholder("archestra", "server_id"),
        },
      },
      template: {
        metadata: {
          labels: {
            app: "mcp-server",
            "mcp-server-id": placeholder("archestra", "server_id"),
            "mcp-server-name": placeholder("archestra", "server_name"),
          },
          // annotations: {}
        },
        spec: {
          terminationGracePeriodSeconds: 5,
          serviceAccountName: placeholder("archestra", "service_account"),
          containers: [containerSpec],
          restartPolicy: "Always",
        },
      },
    },
  };

  // Convert to YAML
  const yamlString = yaml.dump(deploymentSpec, {
    lineWidth: -1, // Don't wrap lines
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
    sortKeys: false,
  });

  return yamlString;
}

/**
 * Validates a deployment YAML string.
 *
 * @param yamlString - The YAML string to validate
 * @returns Validation result with errors and warnings
 */
export function validateDeploymentYaml(
  yamlString: string,
): YamlValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Try to parse the YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlString);
  } catch (e) {
    const error = e as Error;
    errors.push(`YAML syntax error: ${error.message}`);
    return { valid: false, errors, warnings };
  }

  // Check if it's an object
  if (!parsed || typeof parsed !== "object") {
    errors.push("YAML must be a valid object");
    return { valid: false, errors, warnings };
  }

  const spec = parsed as Record<string, unknown>;

  // Check required fields
  if (spec.apiVersion !== "apps/v1") {
    errors.push('apiVersion must be "apps/v1"');
  }

  if (spec.kind !== "Deployment") {
    errors.push('kind must be "Deployment"');
  }

  // Check metadata
  if (!spec.metadata || typeof spec.metadata !== "object") {
    errors.push("metadata is required");
  }

  // Check spec
  if (!spec.spec || typeof spec.spec !== "object") {
    errors.push("spec is required");
  } else {
    const deploymentSpec = spec.spec as Record<string, unknown>;

    // Check template
    if (
      !deploymentSpec.template ||
      typeof deploymentSpec.template !== "object"
    ) {
      errors.push("spec.template is required");
    } else {
      const template = deploymentSpec.template as Record<string, unknown>;

      // Check template.spec
      if (!template.spec || typeof template.spec !== "object") {
        errors.push("spec.template.spec is required");
      } else {
        const podSpec = template.spec as Record<string, unknown>;

        // Check containers
        if (
          !Array.isArray(podSpec.containers) ||
          podSpec.containers.length === 0
        ) {
          errors.push(
            "spec.template.spec.containers must have at least one container",
          );
        }
      }
    }
  }

  // Validate placeholders
  const placeholderWarnings = validatePlaceholders(yamlString);
  warnings.push(...placeholderWarnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates placeholder syntax in the YAML.
 */
function validatePlaceholders(yamlString: string): string[] {
  const warnings: string[] = [];

  // Remove YAML comments before validating placeholders
  // This prevents warnings for documentation examples like ${archestra.*}
  const yamlWithoutComments = yamlString
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  // Find all placeholders
  const allPlaceholders = yamlWithoutComments.match(/\$\{[^}]+\}/g) || [];

  for (const placeholder of allPlaceholders) {
    // Extract the placeholder content
    const content = placeholder.slice(2, -1); // Remove ${ and }
    const [prefix, key] = content.split(".");

    if (!key) {
      warnings.push(`Invalid placeholder format: ${placeholder}`);
      continue;
    }

    if (prefix === "archestra") {
      // Check if it's a known archestra placeholder
      if (
        !ARCHESTRA_PLACEHOLDERS.includes(
          key as (typeof ARCHESTRA_PLACEHOLDERS)[number],
        )
      ) {
        warnings.push(`Unknown archestra placeholder: ${placeholder}`);
      }
    } else if (prefix !== "env" && prefix !== "secret") {
      warnings.push(
        `Unknown placeholder prefix: ${placeholder} (use env, secret, or archestra)`,
      );
    }
  }

  return warnings;
}

/**
 * Resolves placeholders in a YAML string with actual values.
 *
 * @param yamlString - The YAML string with placeholders
 * @param context - Values for archestra placeholders
 * @param envValues - Values for env placeholders
 * @param secretName - Name of the K8s secret for secret placeholders
 * @returns Resolved YAML string
 */
export function resolvePlaceholders(
  yamlString: string,
  context: {
    deploymentName: string;
    serverId: string;
    serverName: string;
    namespace: string;
    dockerImage: string;
    secretName: string;
    command?: string;
    arguments?: string[];
    serviceAccount?: string;
  },
  envValues: Record<string, string>,
): string {
  let resolved = yamlString;

  // Resolve archestra placeholders
  const archestraMap: Record<string, string> = {
    deployment_name: context.deploymentName,
    server_id: context.serverId,
    server_name: context.serverName,
    namespace: context.namespace,
    docker_image: context.dockerImage,
    secret_name: context.secretName,
    command: context.command || "",
    arguments: JSON.stringify(context.arguments || []),
    service_account: context.serviceAccount || "default",
  };

  resolved = resolved.replace(PLACEHOLDER_PATTERNS.archestra, (_, key) => {
    return archestraMap[key] || "";
  });

  // Resolve env placeholders
  resolved = resolved.replace(PLACEHOLDER_PATTERNS.env, (_, key) => {
    return envValues[key] || "";
  });

  // Note: secret placeholders are not resolved here - they remain as secretKeyRef in the YAML
  // The K8s API will resolve them at runtime

  return resolved;
}

/**
 * Parses YAML and merges it with system-managed values.
 *
 * ## Protected Fields (always overwritten)
 *
 * These fields are system-managed and will be overwritten regardless of YAML values:
 *
 * - `metadata.name` - Set to system-generated deployment name
 * - `metadata.labels` - System labels merged in (take precedence over user labels):
 *   - `app: "mcp-server"`
 *   - `mcp-server-id: <serverId>`
 *   - `mcp-server-name: <serverName>`
 * - `spec.selector.matchLabels` - Always set to system labels (required for pod selection)
 * - `spec.template.metadata.labels` - System labels merged in (required for selector matching)
 *
 * ## User-Customizable Fields
 *
 * @param yamlString - The user's YAML string
 * @param systemValues - System-managed values that must be applied
 * @returns Merged K8s Deployment spec, or null if parsing failed
 */
export function customYamlToDeployment(
  yamlString: string,
  systemValues: {
    deploymentName: string;
    serverId: string;
    serverName: string;
    labels: Record<string, string>;
  },
): k8s.V1Deployment | null {
  try {
    const parsed = yaml.load(yamlString) as k8s.V1Deployment;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    // Ensure required structure exists
    if (!parsed.metadata) {
      parsed.metadata = {};
    }
    if (!parsed.spec) {
      parsed.spec = {} as k8s.V1DeploymentSpec;
    }
    if (!parsed.spec.template) {
      parsed.spec.template = {};
    }
    if (!parsed.spec.template.metadata) {
      parsed.spec.template.metadata = {};
    }

    // Override protected fields
    parsed.metadata.name = systemValues.deploymentName;

    // Merge labels (system labels take precedence)
    parsed.metadata.labels = {
      ...(parsed.metadata.labels || {}),
      ...systemValues.labels,
    };

    // Set selector matchLabels (always system-managed)
    parsed.spec.selector = {
      matchLabels: systemValues.labels,
    };

    // Merge template labels
    parsed.spec.template.metadata.labels = {
      ...(parsed.spec.template.metadata.labels || {}),
      ...systemValues.labels,
    };

    // YAML parser converts "true"/"false" to booleans and numbers to numbers.
    // K8s env var values must be strings, so convert them back.
    const containers = parsed.spec.template?.spec?.containers;
    if (containers) {
      for (const container of containers) {
        if (container.env) {
          for (const envVar of container.env) {
            if (envVar.value != null && typeof envVar.value !== "string") {
              envVar.value = String(envVar.value);
            }
          }
        }
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Merges environment variables from localConfig into existing YAML.
 * Preserves all user customizations (labels, resources, annotations, etc.)
 * while syncing the env section with the current localConfig.environment.
 *
 * @param yamlString - The existing YAML string (may have user customizations)
 * @param environment - Current environment variables from localConfig
 * @param previouslyManagedKeys - Keys that were previously managed by localConfig.environment.
 *   Any key in this set but not in the new environment will be removed from YAML.
 *   If not provided, all existing env vars not in the new environment are preserved.
 * @returns Updated YAML string with merged environment variables
 */
export function mergeLocalConfigIntoYaml(
  yamlString: string,
  environment: Array<{
    key: string;
    type: "plain_text" | "secret" | "boolean" | "number";
    promptOnInstallation: boolean;
    mounted?: boolean;
  }>,
  previouslyManagedKeys?: Set<string>,
): string {
  try {
    // Extract comments from the beginning of the YAML
    const lines = yamlString.split("\n");
    const commentLines: string[] = [];
    let contentStartIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("#") || trimmed === "") {
        commentLines.push(lines[i]);
        contentStartIndex = i + 1;
      } else {
        break;
      }
    }

    const yamlContent = lines.slice(contentStartIndex).join("\n");
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;

    if (!parsed || typeof parsed !== "object") {
      return yamlString;
    }

    // Navigate to containers array
    const spec = parsed.spec as Record<string, unknown> | undefined;
    const template = spec?.template as Record<string, unknown> | undefined;
    const podSpec = template?.spec as Record<string, unknown> | undefined;
    const containers = podSpec?.containers as
      | Array<Record<string, unknown>>
      | undefined;

    if (!containers || containers.length === 0) {
      return yamlString;
    }

    const container = containers[0];

    // Get existing env vars from the YAML to preserve unmanaged ones
    const existingEnv =
      (container.env as Array<{
        name: string;
        value?: string;
        valueFrom?: unknown;
      }>) || [];

    // Build new env section from localConfig.environment
    const newEnvSection: Array<{
      name: string;
      value?: string;
      valueFrom?: { secretKeyRef: { name: string; key: string } };
    }> = [];

    // Track mounted secrets for volume configuration
    const mountedSecrets: Array<{ key: string }> = [];

    // Track keys managed by localConfig.environment
    const managedKeys = new Set<string>();

    for (const envVar of environment) {
      managedKeys.add(envVar.key);
      if (envVar.type === "secret") {
        if (envVar.mounted) {
          // Mounted secrets are handled via volumes, not env vars
          mountedSecrets.push({ key: envVar.key });
        } else {
          // Secret type: use secretKeyRef
          newEnvSection.push({
            name: envVar.key,
            valueFrom: {
              secretKeyRef: {
                name: placeholder("archestra", "secret_name"),
                key: envVar.key,
              },
            },
          });
        }
      } else {
        // Plain text, boolean, number: use placeholder
        newEnvSection.push({
          name: envVar.key,
          value: placeholder("env", envVar.key),
        });
      }
    }

    // Preserve existing env vars that are not managed by localConfig.environment
    // BUT remove env vars that were previously managed and are now removed
    for (const existingVar of existingEnv) {
      if (!managedKeys.has(existingVar.name)) {
        // If we know what was previously managed, only preserve truly unmanaged vars
        // (i.e., user-added custom env vars that were never in localConfig.environment)
        const wasManaged =
          previouslyManagedKeys?.has(existingVar.name) ?? false;
        if (!wasManaged) {
          newEnvSection.push(existingVar as (typeof newEnvSection)[number]);
        }
        // If wasManaged is true, this env var was removed from localConfig - don't preserve it
      }
    }

    // Update the container's env section
    if (newEnvSection.length > 0) {
      container.env = newEnvSection;
    } else {
      // Remove env section if no env vars
      delete container.env;
    }

    // Handle volume mounts for mounted secrets
    if (mountedSecrets.length > 0) {
      // Add volume mounts to container
      const volumeMounts: Array<{
        name: string;
        mountPath: string;
        subPath: string;
        readOnly: boolean;
      }> = mountedSecrets.map(({ key }) => ({
        name: "mounted-secrets",
        mountPath: `/secrets/${key}`,
        subPath: key,
        readOnly: true,
      }));

      container.volumeMounts = volumeMounts;

      // Add volumes to pod spec
      if (podSpec) {
        const volumes: Array<{
          name: string;
          secret: {
            secretName: string;
            items: Array<{ key: string; path: string }>;
          };
        }> = [
          {
            name: "mounted-secrets",
            secret: {
              secretName: placeholder("archestra", "secret_name"),
              items: mountedSecrets.map(({ key }) => ({ key, path: key })),
            },
          },
        ];

        podSpec.volumes = volumes;
      }
    } else {
      // Remove volume-related config if no mounted secrets
      delete container.volumeMounts;
      // Only remove volumes if they were for mounted-secrets
      if (podSpec) {
        const existingVolumes = podSpec.volumes as
          | Array<Record<string, unknown>>
          | undefined;
        if (existingVolumes) {
          const filteredVolumes = existingVolumes.filter(
            (v) => v.name !== "mounted-secrets",
          );
          if (filteredVolumes.length > 0) {
            podSpec.volumes = filteredVolumes;
          } else {
            delete podSpec.volumes;
          }
        }
      }
    }

    // Convert back to YAML
    const updatedYaml = yaml.dump(parsed, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
      noRefs: true,
      sortKeys: false,
    });

    // Prepend the original comments
    if (commentLines.length > 0) {
      return [...commentLines, updatedYaml].join("\n");
    }

    return updatedYaml;
  } catch {
    // If anything fails, return the original YAML unchanged
    return yamlString;
  }
}
