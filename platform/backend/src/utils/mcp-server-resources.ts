import {
  cpuQuantity,
  isPlaywrightCatalogItem,
  type McpServerResources,
  memoryQuantity,
} from "@archestra/shared";
import config from "@/config";

// Chromium needs more memory than a small tool server. Preserve the existing
// built-in Playwright defaults when its catalog does not override them.
const PLAYWRIGHT_MEMORY_REQUEST = "512Mi";
const PLAYWRIGHT_MEMORY_LIMIT = "2Gi";

/** Shared by generated deployments and the YAML editor's initial template. */
export function resolveMcpServerResources(
  tier?: McpServerResources,
  catalogId?: string,
) {
  const defaults = config.orchestrator.mcpServerResources;
  const playwright = isPlaywrightCatalogItem(catalogId ?? "");
  const resources = {
    requests: {
      cpu:
        tier?.cpuRequest === undefined
          ? defaults.requests.cpu
          : cpuQuantity(tier.cpuRequest),
      memory:
        tier?.memoryRequestMiB === undefined
          ? playwright
            ? PLAYWRIGHT_MEMORY_REQUEST
            : defaults.requests.memory
          : memoryQuantity(tier.memoryRequestMiB),
      "ephemeral-storage": defaults.requests.ephemeralStorage,
    },
    limits: {
      ...(tier?.cpuLimit == null ? {} : { cpu: cpuQuantity(tier.cpuLimit) }),
      memory:
        tier?.memoryLimitMiB === undefined
          ? playwright
            ? PLAYWRIGHT_MEMORY_LIMIT
            : defaults.limits.memory
          : memoryQuantity(tier.memoryLimitMiB),
      "ephemeral-storage": defaults.limits.ephemeralStorage,
    },
  };
  return resources;
}
