import type { archestraApiTypes } from "@shared";
import type {
  transformToolInvocationPolicies,
  transformToolResultPolicies,
} from "@/lib/policy.utils";

export type ToolsInitialData = {
  toolsWithAssignments: archestraApiTypes.GetToolsWithAssignmentsResponses["200"];
  internalMcpCatalog: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
  toolInvocationPolicies: ReturnType<typeof transformToolInvocationPolicies>;
  toolResultPolicies: ReturnType<typeof transformToolResultPolicies>;
};
