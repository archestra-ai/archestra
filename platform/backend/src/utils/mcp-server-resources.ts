import {
  ApiError,
  cpuQuantity,
  isPlaywrightCatalogItem,
  type McpServerResources,
  McpServerResourcesSchema,
  memoryQuantity,
  parseCpuQuantity,
} from "@archestra/shared";
import config, { k8sMemoryQuantityToBytes } from "@/config";

// Chromium needs more memory than a small tool server. Preserve the existing
// built-in Playwright defaults when its catalog does not override them.
const PLAYWRIGHT_MEMORY_REQUEST = "512Mi";
const PLAYWRIGHT_MEMORY_LIMIT = "2Gi";

/** Shared by generated deployments and the YAML editor's initial template. */
export function resolveMcpServerResources(
  overrides?: McpServerResources,
  catalogId?: string,
) {
  const defaults = config.orchestrator.mcpServerResources;
  const playwright = isPlaywrightCatalogItem(catalogId ?? "");
  const resources = {
    requests: {
      cpu:
        overrides?.cpuRequest === undefined
          ? defaults.requests.cpu
          : cpuQuantity(overrides.cpuRequest),
      memory:
        overrides?.memoryRequestMiB === undefined
          ? playwright
            ? PLAYWRIGHT_MEMORY_REQUEST
            : defaults.requests.memory
          : memoryQuantity(overrides.memoryRequestMiB),
      "ephemeral-storage": defaults.requests.ephemeralStorage,
    },
    limits: {
      ...(overrides?.cpuLimit == null
        ? {}
        : { cpu: cpuQuantity(overrides.cpuLimit) }),
      memory:
        overrides?.memoryLimitMiB === undefined
          ? playwright
            ? PLAYWRIGHT_MEMORY_LIMIT
            : defaults.limits.memory
          : memoryQuantity(overrides.memoryLimitMiB),
      "ephemeral-storage": defaults.limits.ephemeralStorage,
    },
  };
  if (overrides !== undefined) {
    const parsed = McpServerResourcesSchema.safeParse(overrides);
    if (!parsed.success)
      throw new ApiError(400, parsed.error.issues[0].message);
    if (
      overrides.cpuLimit != null &&
      (parseCpuQuantity(resources.requests.cpu) ?? 0) > overrides.cpuLimit
    ) {
      throw new ApiError(
        400,
        "CPU limit must be at least the effective CPU request (including the deployment default)",
      );
    }
    if (
      (k8sMemoryQuantityToBytes(resources.requests.memory) ?? 0) >
      (k8sMemoryQuantityToBytes(resources.limits.memory) ?? 0)
    ) {
      throw new ApiError(
        400,
        "Memory limit must be at least the effective memory request (including the deployment default)",
      );
    }
  }
  return resources;
}
